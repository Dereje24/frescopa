// Offer Management runtime for published Edge Delivery (xwalk) pages: applies Adobe Target JSON
// offers (`om-eds-fragment` / `om-eds-default`, version 1) to the page's Offer Management slots.
// Site-agnostic: the host passes its config (origins, SDK) and its rendering pipeline (hooks).
// Never throws to the page; on any failure the authored default content stays.
import { selectOffer } from './offers.js';
import {
  defaultResolveSlots, discoverSlots, STATE_ATTR,
} from './slots.js';
import {
  MAX_FRAGMENT_BYTES, buildFragment, fail, fetchFragment, normalizeOrigins, observeDisplay,
  parseFragment, resolveFragmentUrl, swapSlot,
} from './render.js';
import { requestDecisions } from './decisions.js';

export { parseOffer, selectOffer, MBOX_PATTERN } from './offers.js';
export {
  defaultResolveSlots, readIdentity, normalizeSlots, hasSlots,
} from './slots.js';
export { resolveFragmentUrl, parseFragment } from './render.js';
export { createSdkAdapter } from './decisions.js';

export const DEFAULT_TIMEOUT_MS = 1000;
export const DEFAULT_LATE_TIMEOUT_MS = 5000;
export const TIMEOUT_META = 'personalization-timeout';
const MAX_META_TIMEOUT_MS = 10000;
const LOG_PREFIX = '[offer-management]';

function withTimeout(promise, ms, onTimeout, reason = 'timeout') {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(fail(reason));
      }
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Prehide via CSSOM (not an injected <style>), so a strict style-src CSP does not block it.
const hidden = new WeakMap();
function prehide(element) {
  const { style } = element;
  hidden.set(element, [style.getPropertyValue('visibility'), style.getPropertyPriority('visibility')]);
  style.setProperty('visibility', 'hidden', 'important');
}
function reveal(element) {
  if (!hidden.has(element)) return;
  const [value, priority] = hidden.get(element);
  hidden.delete(element);
  if (value) element.style.setProperty('visibility', value, priority);
  else element.style.removeProperty('visibility');
  if (element.getAttribute('style') === '') element.removeAttribute('style');
}

const validHost = (host) => typeof host?.decorate === 'function'
  && ['loadSections', 'loadBlocks', 'loadBlock'].some((hook) => typeof host[hook] === 'function');

function settle(slot, state, reason) {
  Object.assign(slot.result, { state, ...(reason && { reason }) });
  if (slot.element.getAttribute(STATE_ATTR) === 'pending') {
    slot.element.setAttribute(STATE_ATTR, state === 'rendered' ? 'replaced' : state);
  }
}

async function processSlot(slot, decision, ctx) {
  const { element, mbox } = slot;
  const selection = selectOffer(decision.propositions, mbox);
  if (!selection) {
    settle(slot, 'unchanged');
    return;
  }
  if (selection.reason) {
    ctx.warn(mbox, selection.reason);
    settle(slot, 'unchanged', selection.reason);
    return;
  }
  const { proposition, offer } = selection;
  const report = (elements) => observeDisplay(
    elements,
    () => decision.display(proposition),
    () => ctx.warn(mbox, 'display-failed'),
    ctx.win,
  );
  if (offer.kind === 'default') {
    settle(slot, 'default');
    reveal(element);
    report([element]);
    return;
  }
  const fetchURL = resolveFragmentUrl(offer.url, ctx.fragmentOrigins, ctx.fetchOrigin);
  if (!fetchURL) {
    ctx.warn(mbox, 'invalid-url');
    settle(slot, 'failed', 'invalid-url');
    return;
  }
  const controller = new AbortController();
  let expired = false;
  try {
    const wrappers = await withTimeout((async () => {
      const html = await fetchFragment(fetchURL, {
        fetch: ctx.fetch, signal: controller.signal, maxBytes: ctx.maxBytes,
      });
      if (expired) throw fail(ctx.expiredReason);
      const content = parseFragment(html, {
        doc: ctx.doc, baseURL: fetchURL, mediaOrigins: ctx.mediaOrigins, sanitize: ctx.host.sanitize,
      });
      return buildFragment(content, ctx.host, ctx.doc);
    })(), ctx.remaining(), () => {
      expired = true;
      controller.abort();
    }, ctx.expiredReason);
    if (expired || ctx.remaining() <= 0) throw fail(ctx.expiredReason);
    if (!element.isConnected || !ctx.main.contains(element)
        || element.getAttribute(STATE_ATTR) !== 'pending') {
      throw fail('slot-changed');
    }
    reveal(element);
    const inserted = swapSlot(element, wrappers, mbox);
    settle(slot, 'rendered');
    report(inserted);
  } catch (e) {
    const reason = expired ? ctx.expiredReason : (e?.reason || 'render-failed');
    ctx.warn(mbox, reason);
    settle(slot, 'failed', reason);
  }
}

// Per-page first-section budget from EDS page metadata ("Personalization Timeout"): an integer
// number of ms in [0, 10000]; anything else is ignored with one static warning.
function readMetaTimeout(doc, warn) {
  const meta = doc.querySelector?.(`meta[name="${TIMEOUT_META}"]`);
  if (!meta) return undefined;
  const raw = (meta.getAttribute('content') ?? '').trim();
  const value = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (value >= 0 && value <= MAX_META_TIMEOUT_MS) return value;
  warn(null, 'invalid-timeout');
  return undefined;
}

/**
 * Applies Offer Management JSON offers to the slots in `main`, in two groups:
 *
 * - **First section** (the first `.section` of `main`, the one the site holds for LCP, see
 *   `hasSlots`): decision + fetch + render bounded by `timeout` (default 1000 ms from the call,
 *   overridable per page with `<meta name="personalization-timeout" content="<ms>">`). On
 *   expiry they keep their default (`timeout` / `decision-timeout`); nothing is swapped in later.
 * - **Later sections**: not bound by `timeout`. Processed once the decision arrives, attempted
 *   once and kept hidden until settled, with a safety cap `lateTimeout` (default 5000 ms from the
 *   call) after which an unsettled slot keeps its default (`late-timeout`).
 *
 * The returned promise resolves once the first-section slots have settled — await it before
 * showing the first section when `hasSlots(firstSection)` — with `{ slots, done }`: `slots` is the
 * live list of every slot's result (later ones may still be `pending`) and `done` resolves with
 * `{ slots }` once every slot has settled. Neither ever rejects.
 *
 * @param {Element} main the page's decorated `<main>`
 * @param {object} [config]
 * @param {*} [config.sdk] initialized aem-martech module, Alloy instance or `{sendEvent}`
 * @param {Function} [config.loadSdk] `() => Promise<sdk>`, called only when slots exist
 * @param {string[]} [config.fragmentOrigins] allowed fragment origins (default: page origin)
 * @param {boolean} [config.rebaseToPageOrigin=true] fetch the validated fragment path from the page's
 *   own origin (offer URLs name the site's aem.live origin, which sends no CORS headers)
 * @param {string[]} [config.mediaOrigins] allowed media origins (default: fragment + page origins)
 * @param {number} [config.timeout=1000] first-section budget in ms from the call (SDK load,
 *   decision, fragment fetch + render of the first section's slots); the page's
 *   `personalization-timeout` meta, when valid, takes precedence
 * @param {number} [config.lateTimeout=5000] safety cap in ms from the call for slots in later
 *   sections (never less than the first-section budget)
 * @param {number} [config.renderTimeout] deprecated and ignored
 * @param {number} [config.maxFragmentBytes=1048576]
 * @param {Function} [config.resolveSlots] `(main) => Array<{element, mbox}>`
 * @param {string} [config.pageURL] page URL for the decision request (aem-martech only)
 * @param {{warn: Function}} [config.logger=console]
 * @param {boolean} [config.enabled=true]
 * @param {object} host the site's pipeline
 * @param {Function} host.decorate `(main) => void` — e.g. the site's `decorateMain`
 * @param {Function} [host.loadSections] `(main) => Promise` — e.g. aem.js `loadSections`
 * @param {Function} [host.loadBlocks] `(main) => Promise` — alternative loader
 * @param {Function} [host.loadBlock] `(block) => Promise` — alternative loader
 * @param {Function} [host.sanitize] `(html) => string`, e.g. DOMPurify.sanitize (runs first)
 * @param {Function} [host.fetch] fetch implementation (default: window.fetch)
 * @returns {Promise<{
 *   slots: Array<{mbox: string, state: string, reason?: string}>,
 *   done: Promise<{slots: Array<{mbox: string, state: string, reason?: string}>}>
 * }>}
 */
export async function startOfferManagement(main, config = {}, host = {}) {
  const started = Date.now();
  const slotResults = [];
  const result = { slots: slotResults };
  let all = Promise.resolve();
  const options = config && typeof config === 'object' ? config : {};
  const logger = typeof options.logger?.warn === 'function' ? options.logger : console;
  // Static reason codes and slot mboxes only: never offer content, URLs, identities or markup.
  const warn = (mbox, reason) => {
    try {
      logger.warn(`${LOG_PREFIX} ${mbox ? `${mbox}: ` : ''}${reason}`);
    } catch {
      // logging must never break the page
    }
  };
  try {
    if (!main || main.nodeType !== 1 || options.enabled === false) return result;
    if (!validHost(host)) {
      warn(null, 'invalid-host');
      return result;
    }
    const doc = main.ownerDocument;
    const win = doc.defaultView || globalThis;
    const resolve = typeof options.resolveSlots === 'function'
      ? options.resolveSlots : defaultResolveSlots;
    const slots = discoverSlots(main, resolve, warn).map((slot) => ({
      ...slot, result: { mbox: slot.mbox, state: 'pending' },
    }));
    slotResults.push(...slots.map((slot) => slot.result));
    if (!slots.length) return result;

    const budget = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
    const timeoutMs = readMetaTimeout(doc, warn) ?? budget(options.timeout, DEFAULT_TIMEOUT_MS);
    const lateMs = Math.max(timeoutMs, budget(options.lateTimeout, DEFAULT_LATE_TIMEOUT_MS));
    const pageOrigin = win.location?.origin;
    const fragmentOrigins = normalizeOrigins(options.fragmentOrigins ?? [pageOrigin]);
    const ctx = {
      main,
      doc,
      win,
      host,
      warn,
      fragmentOrigins,
      fetchOrigin: options.rebaseToPageOrigin === false ? null : pageOrigin,
      mediaOrigins: normalizeOrigins(options.mediaOrigins ?? [...fragmentOrigins, pageOrigin]),
      maxBytes: budget(options.maxFragmentBytes, MAX_FRAGMENT_BYTES),
      fetch: host.fetch || (typeof win.fetch === 'function' ? win.fetch.bind(win) : globalThis.fetch),
    };

    // One decision request for every slot; with Target all decisions come back in that call.
    const outcome = Promise.resolve()
      .then(() => requestDecisions(options, slots.map(({ mbox }) => mbox)))
      .then((decision) => ({ decision }), (e) => ({ reason: e?.reason || 'decision-failed' }));
    const logged = new Set();
    const warnOnce = (reason) => {
      if (logged.has(reason)) return;
      logged.add(reason);
      warn(null, reason);
    };

    const runGroup = async (group, ms, expiredReason) => {
      if (!group.length) return;
      const deadline = started + ms;
      const remaining = () => Math.max(0, deadline - Date.now());
      try {
        group.forEach(({ element }) => {
          element.setAttribute(STATE_ATTR, 'pending');
          prehide(element);
        });
        const decided = await withTimeout(outcome, remaining()).catch(() => ({
          reason: expiredReason === 'timeout' ? 'decision-timeout' : expiredReason,
        }));
        if (decided.reason) {
          warnOnce(decided.reason);
          group.forEach((slot) => settle(slot, 'failed', decided.reason));
          return;
        }
        const groupCtx = { ...ctx, remaining, expiredReason };
        await Promise.all(group.map((slot) => processSlot(slot, decided.decision, groupCtx)));
      } finally {
        group.forEach((slot) => {
          if (slot.result.state === 'pending') {
            warn(slot.mbox, 'internal-error');
            settle(slot, 'failed', 'internal-error');
          }
          reveal(slot.element);
        });
      }
    };
    const guard = (promise) => promise.catch(() => warn(null, 'internal-error'));

    const firstSection = main.querySelector('.section') || main.firstElementChild;
    const isFirst = (slot) => !!firstSection?.contains(slot.element);
    const early = guard(runGroup(slots.filter(isFirst), timeoutMs, 'timeout'));
    const late = guard(runGroup(slots.filter((slot) => !isFirst(slot)), lateMs, 'late-timeout'));
    all = Promise.all([early, late]);
    await early;
  } catch {
    warn(null, 'internal-error');
  } finally {
    result.done = all.then(() => ({ slots: slotResults }), () => ({ slots: slotResults }));
  }
  return result;
}
