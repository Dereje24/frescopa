// Fragment fetch, sanitization, host-pipeline rendering and the atomic swap. Knows no decision
// provider. Every failure throws an error carrying a static `reason` code; the live page is only
// touched by `swapSlot`, in one DOM operation.
import { stampIdentity, stripIdentity, STATE_ATTR, PART_ATTR } from './slots.js';

export const MAX_FRAGMENT_BYTES = 1024 * 1024;
const PATH = /^\/[A-Za-z0-9._~\-/]+$/;
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export function fail(reason, cause) {
  return Object.assign(new Error(reason), { reason, cause });
}

/** Normalizes configured origins (`https://host[:port]`), dropping invalid entries. */
export function normalizeOrigins(origins) {
  return (Array.isArray(origins) ? origins : []).map((origin) => {
    try {
      const url = new URL(origin);
      return url.origin === 'null' ? null : url.origin;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Applies the fragment URL policy and returns the `.plain.html` URL to fetch, or null.
 * https only (http only for an allowlisted localhost origin), origin in `origins`, a path under
 * `/variants/`, no credentials, query or hash. Any extension on the last segment is dropped.
 * When `fetchOrigin` is given (normally the page's own origin), the validated path is fetched from it
 * instead: offer URLs name the site's `*.aem.live` origin, which sends no CORS headers, while the page
 * may be served from a branch preview or the customer's own domain with the same content.
 * @param {string} value the offer's `url`
 * @param {string[]} origins normalized allowed origins
 */
export function resolveFragmentUrl(value, origins, fetchOrigin) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:'
    || (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash
      || value.includes('#') || value.includes('?') || value.includes('\\')
      || !origins.includes(url.origin) || !PATH.test(url.pathname)
      || !url.pathname.includes('/variants/')) {
    return null;
  }
  const segments = url.pathname.split('/');
  const last = segments.pop().replace(/\..*$/, '');
  if (!last || segments.some((segment, i) => i > 0 && !segment)) return null;
  return `${secureOrigin(fetchOrigin) || url.origin}${[...segments, last].join('/')}.plain.html`;
}

function secureOrigin(origin) {
  if (typeof origin !== 'string') return null;
  try {
    const url = new URL(origin);
    const secure = url.protocol === 'https:'
      || (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname));
    return secure && url.origin === origin ? url.origin : null;
  } catch {
    return null;
  }
}

async function readBounded(response, maxBytes) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw fail('oversize');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw fail('oversize');
    return text;
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      throw fail('oversize');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Fetches the fragment markup: no credentials, no redirects, HTML only, size-capped. */
export async function fetchFragment(url, { fetch, signal, maxBytes = MAX_FRAGMENT_BYTES }) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    });
  } catch (e) {
    throw fail(signal?.aborted ? 'timeout' : 'fetch-failed', e);
  }
  if (!response?.ok || response.redirected || (response.url && response.url !== url)
      || !/^text\/html(?:;|$)/i.test(response.headers?.get?.('content-type') || '')) {
    throw fail('fetch-failed');
  }
  try {
    return await readBounded(response, maxBytes);
  } catch (e) {
    throw e.reason ? e : fail(signal?.aborted ? 'timeout' : 'fetch-failed', e);
  }
}

// --- Sanitization -----------------------------------------------------------------------------
// The fragment is parsed in an inert <template> and only ever moved, never re-serialized.
// Active, document-level, embedding, form and style-bearing elements are removed with their
// content; only an allowlist of attributes survives (no on*, style, id/name, UE instrumentation,
// slot identity or the EDS pipeline's own status attributes); URL attributes keep only
// http(s)/mailto/tel (no javascript:, data:, …),
// resolved against the fragment URL, and media must come from an allowed origin.
const REMOVED = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'base', 'meta', 'link', 'template', 'noscript', 'svg', 'math', 'form', 'input', 'button',
  'select', 'textarea', 'option', 'dialog', 'video', 'audio', 'track', 'canvas', 'title',
].join(', ');
const ALLOWED_ATTRIBUTES = new Set([
  'class', 'href', 'src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'loading',
  'media', 'type', 'colspan', 'rowspan', 'headers', 'scope', 'datetime', 'lang', 'dir',
  'rel', 'role', 'start', 'reversed',
]);
const LINK_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

function resolveLink(value, base) {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    return LINK_PROTOCOLS.includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch {
    return null;
  }
}

function resolveMedia(value, base, mediaOrigins) {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && mediaOrigins.includes(url.origin)
      && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function resolveSrcset(value, base, mediaOrigins) {
  const candidates = value.split(',').map((candidate) => candidate.trim()).filter(Boolean);
  const resolved = candidates.map((candidate) => {
    const [src, ...descriptor] = candidate.split(/\s+/);
    const url = resolveMedia(src, base, mediaOrigins);
    return url && descriptor.every((d) => /^\d+(\.\d+)?[wx]$/.test(d))
      ? [url, ...descriptor].join(' ') : null;
  });
  return resolved.length && resolved.every(Boolean) ? resolved.join(', ') : null;
}

function cleanAttribute(element, { name, value }, base, mediaOrigins) {
  const attr = name.toLowerCase();
  if (attr.startsWith('aria-')) return;
  if (attr.startsWith('data-') && /^data-[a-z0-9-]+$/.test(attr)
      && !/^data-(aue-|richtext-|om-|block-status$|block-name$|section-status$)/.test(attr)) return;
  if (!ALLOWED_ATTRIBUTES.has(attr)) {
    element.removeAttribute(name);
    return;
  }
  let safe = value;
  if (attr === 'href') safe = resolveLink(value, base);
  if (attr === 'src') safe = resolveMedia(value, base, mediaOrigins);
  if (attr === 'srcset') safe = resolveSrcset(value, base, mediaOrigins);
  if (safe === null) element.removeAttribute(name);
  else if (safe !== value) element.setAttribute(name, safe);
}

function removeComments(node) {
  [...node.childNodes].forEach((child) => {
    if (child.nodeType === 8) child.remove();
    else if (child.childNodes?.length) removeComments(child);
  });
}

/**
 * Parses and sanitizes `.plain.html` markup into an inert DocumentFragment of section divs.
 * Throws `invalid-markup` unless the top level is one or more `<div>` sections with content.
 * @param {string} html
 * @param {{doc: Document, baseURL: string, mediaOrigins: string[], sanitize?: Function}} options
 *   `sanitize` is an optional host pre-sanitizer (e.g. DOMPurify.sanitize) returning a string
 */
export function parseFragment(html, {
  doc, baseURL, mediaOrigins, sanitize,
}) {
  let markup = html;
  if (typeof sanitize === 'function') {
    try {
      markup = sanitize(html);
    } catch (e) {
      throw fail('invalid-markup', e);
    }
  }
  if (typeof markup !== 'string') throw fail('invalid-markup');
  const template = doc.createElement('template');
  template.innerHTML = markup;
  const root = template.content;
  root.querySelectorAll(REMOVED).forEach((element) => element.remove());
  removeComments(root);
  root.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attr) => cleanAttribute(element, attr, baseURL, mediaOrigins));
  });
  stripIdentity(root);
  const top = [...root.childNodes].filter((node) => node.nodeType !== 3 || node.textContent.trim());
  if (!top.length || top.some((node) => node.nodeType !== 1 || node.tagName !== 'DIV')
      || !top.some((section) => section.textContent.trim() || section.querySelector('img'))) {
    throw fail('invalid-markup');
  }
  return root;
}

/**
 * Renders sanitized sections with the HOST's pipeline in a detached `<main>`: `host.decorate`
 * (the site's decorateMain), then `host.loadSections` / `host.loadBlocks` / `host.loadBlock`.
 * @returns {Promise<Element[]>} the rendered wrappers of every section, in order
 */
export async function buildFragment(content, host, doc) {
  const detached = doc.createElement('main');
  detached.append(content);
  try {
    await host.decorate(detached);
  } catch (e) {
    throw fail('decorate-failed', e);
  }
  const sections = [...detached.children].filter((child) => child.classList.contains('section'));
  const wrappers = sections.flatMap((section) => [...section.children]);
  if (!wrappers.length) throw fail('decorate-failed');
  try {
    if (typeof host.loadSections === 'function') await host.loadSections(detached);
    else if (typeof host.loadBlocks === 'function') await host.loadBlocks(detached);
    else {
      const blocks = [...detached.querySelectorAll('.block')];
      for (let i = 0; i < blocks.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await host.loadBlock(blocks[i]);
      }
    }
  } catch (e) {
    throw fail('load-failed', e);
  }
  if ([...detached.querySelectorAll('.block')]
    .some((block) => block.dataset.blockStatus !== 'loaded')) {
    throw fail('load-failed');
  }
  const styles = sections.length === 1 ? [...sections[0].classList]
    .filter((token) => token !== 'section' && !token.endsWith('-container')) : [];
  return Object.assign(wrappers, { sectionStyles: styles });
}

/**
 * Replaces the slot with the rendered wrappers in one DOM operation. When the slot block is
 * alone in its wrapper, the wrappers replace that wrapper (so the site's section layout CSS
 * applies to them as to any block); otherwise a single container replaces the slot. The first
 * inserted element carries the slot identity; section `<block>-container` classes follow.
 * @returns {Element[]} the inserted elements
 */
export function swapSlot(slot, wrappers, mbox) {
  const doc = slot.ownerDocument;
  const hostWrapper = slot.parentElement;
  const section = hostWrapper?.parentElement?.classList.contains('section')
    ? hostWrapper.parentElement : null;
  const oldName = /^[a-z][a-z0-9-]*$/.test(slot.dataset.blockName || '') ? slot.dataset.blockName : '';
  let target = slot;
  let inserted = [...wrappers];
  if (section && hostWrapper.children.length === 1) {
    target = hostWrapper;
  } else {
    const container = doc.createElement('div');
    container.append(...wrappers);
    inserted = [container];
  }
  const [first, ...rest] = inserted;
  stampIdentity(first, mbox);
  first.setAttribute(STATE_ATTR, 'rendered');
  rest.forEach((element) => element.setAttribute(PART_ATTR, mbox));
  const soleContent = section && section.children.length === 1 && target === hostWrapper;
  target.replaceWith(...inserted);
  if (section) {
    inserted.forEach((element) => element.querySelectorAll('.block[data-block-name]')
      .forEach(({ dataset }) => {
        if (/^[a-z][a-z0-9-]*$/.test(dataset.blockName)) section.classList.add(`${dataset.blockName}-container`);
      }));
    if (oldName && !section.querySelector(`.block[data-block-name="${oldName}"]`)) {
      section.classList.remove(`${oldName}-container`);
    }
    if (soleContent && wrappers.sectionStyles?.length) section.classList.add(...wrappers.sectionStyles);
  }
  return inserted;
}

/**
 * Calls `display` once, the first time any of `elements` intersects the viewport. Without
 * IntersectionObserver support, reports immediately. `onFailure` runs if reporting fails.
 */
export function observeDisplay(elements, display, onFailure, win = globalThis) {
  let notified = false;
  const report = async () => {
    if (notified) return;
    notified = true;
    try {
      await display();
    } catch {
      onFailure();
    }
  };
  const Observer = win?.IntersectionObserver;
  if (typeof Observer !== 'function') {
    report();
    return;
  }
  try {
    const observer = new Observer((entries) => {
      if (notified || !entries.some((entry) => entry.isIntersecting
          && entry.intersectionRatio > 0 && entry.target.isConnected)) return;
      observer.disconnect();
      report();
    }, { threshold: Number.EPSILON });
    elements.forEach((element) => observer.observe(element));
  } catch {
    onFailure();
  }
}
