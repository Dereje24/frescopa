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
const LOG_PREFIX = '[offer-management]';

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(fail('timeout'));
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
      if (expired) throw fail('timeout');
      const content = parseFragment(html, {
        doc: ctx.doc, baseURL: fetchURL, mediaOrigins: ctx.mediaOrigins, sanitize: ctx.host.sanitize,
      });
      return buildFragment(content, ctx.host, ctx.doc);
    })(), ctx.remaining(), () => {
      expired = true;
      controller.abort();
    });
    if (expired || ctx.remaining() <= 0) throw fail('timeout');
    if (!element.isConnected || !ctx.main.contains(element)
        || element.getAttribute(STATE_ATTR) !== 'pending') {
      throw fail('slot-changed');
    }
    reveal(element);
    const inserted = swapSlot(element, wrappers, mbox);
    settle(slot, 'rendered');
    report(inserted);
  } catch (e) {
    const reason = e?.reason || 'render-failed';
    ctx.warn(mbox, reason);
    settle(slot, 'failed', reason);
  }
}

/**
 * Applies Offer Management JSON offers to the slots in `main`.
 *
 * Await the returned promise before showing a section that contains a slot (the anti-flicker
 * "hold", see `hasSlots`): it settles once every slot is rendered or has kept its default, within
 * ONE budget, `timeout`, shared by the decision and every slot's fetch + render. Nothing is
 * swapped in after it. It never rejects.
 *
 * @param {Element} main the page's decorated `<main>`
 * @param {object} [config]
 * @param {*} [config.sdk] initialized aem-martech module, Alloy instance or `{sendEvent}`
 * @param {Function} [config.loadSdk] `() => Promise<sdk>`, called only when slots exist
 * @param {string[]} [config.fragmentOrigins] allowed fragment origins (default: page origin)
 * @param {boolean} [config.rebaseToPageOrigin=true] fetch the validated fragment path from the page's
 *   own origin (offer URLs name the site's aem.live origin, which sends no CORS headers)
 * @param {string[]} [config.mediaOrigins] allowed media origins (default: fragment + page origins)
 * @param {number} [config.timeout=1000] total budget in ms from the call (SDK load, decision,
 *   fragment fetch + render for every slot); on expiry pending slots keep their default
 * @param {number} [config.renderTimeout] deprecated and ignored: `timeout` covers rendering
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
 * @returns {Promise<{slots: Array<{mbox: string, state: string, reason?: string}>}>}
 */
export async function startOfferManagement(main, config = {}, host = {}) {
  const started = Date.now();
  const result = { slots: [] };
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
  let slots = [];
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
    slots = discoverSlots(main, resolve, warn).map((slot) => ({
      ...slot, result: { mbox: slot.mbox, state: 'pending' },
    }));
    result.slots = slots.map((slot) => slot.result);
    if (!slots.length) return result;

    const budget = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
    const deadline = started + budget(options.timeout, DEFAULT_TIMEOUT_MS);
    const remaining = () => Math.max(0, deadline - Date.now());
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
      remaining,
      maxBytes: budget(options.maxFragmentBytes, MAX_FRAGMENT_BYTES),
      fetch: host.fetch || (typeof win.fetch === 'function' ? win.fetch.bind(win) : globalThis.fetch),
    };

    slots.forEach(({ element }) => {
      element.setAttribute(STATE_ATTR, 'pending');
      prehide(element);
    });
    try {
      let decision;
      try {
        decision = await withTimeout(
          requestDecisions(options, slots.map(({ mbox }) => mbox)),
          remaining(),
        );
      } catch (e) {
        const reason = e?.reason === 'timeout' ? 'decision-timeout' : (e?.reason || 'decision-failed');
        warn(null, reason);
        slots.forEach((slot) => settle(slot, 'failed', reason));
        return result;
      }
      await Promise.all(slots.map((slot) => processSlot(slot, decision, ctx)));
    } finally {
      slots.forEach((slot) => {
        if (slot.result.state === 'pending') {
          warn(slot.mbox, 'internal-error');
          settle(slot, 'failed', 'internal-error');
        }
        reveal(slot.element);
      });
    }
  } catch {
    warn(null, 'internal-error');
  }
  return result;
}
