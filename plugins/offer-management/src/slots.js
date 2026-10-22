// Slot discovery and identity. A slot is the default block an Offer Management activity
// personalizes; its identity is the recorded `omMbox` (`offer-mgmt-<8 hex>`), carried on the
// published block either as a class token or as `data-om-mbox`.
import { MBOX_PATTERN } from './offers.js';

export const SLOT_ATTR = 'data-om-mbox';
export const STATE_ATTR = 'data-om-state';
export const PART_ATTR = 'data-om-part';
const CANDIDATES = `[${SLOT_ATTR}], [class*="offer-mgmt-"]`;
const INVALID = Symbol('invalid');

/**
 * Reads the mbox an element carries. Only tokens that match the mbox pattern exactly count as
 * identity; all identity inputs on one element must agree.
 * @returns {string|null|symbol} the mbox, null when the element carries none, or INVALID
 */
export function readIdentity(element) {
  const tokens = [...new Set([...(element?.classList || [])]
    .filter((token) => MBOX_PATTERN.test(token)))];
  const attr = element?.getAttribute?.(SLOT_ATTR);
  if (attr !== null && attr !== undefined && !MBOX_PATTERN.test(attr)) return INVALID;
  const values = [...new Set([...tokens, ...(attr ? [attr] : [])])];
  if (values.length > 1) return INVALID;
  return values[0] || null;
}

export const isInvalidIdentity = (value) => value === INVALID;

/**
 * Default resolver: every element in `main` carrying an mbox class token or `data-om-mbox`.
 * Elements with malformed or conflicting identity are returned with `mbox: null` so discovery
 * can refuse them.
 * @param {Element} main
 * @returns {Array<{element: Element, mbox: string|null}>}
 */
export function defaultResolveSlots(main) {
  return [...main.querySelectorAll(CANDIDATES)]
    .map((element) => ({ element, identity: readIdentity(element) }))
    .filter(({ identity }) => identity !== null)
    .map(({ element, identity }) => ({
      element, mbox: identity === INVALID ? null : identity,
    }));
}

/**
 * Resolves and validates the page's slots. One slot per mbox: when several elements carry the
 * same mbox, that mbox is refused (every holder keeps its default). Elements already handled
 * by an earlier run (`data-om-state` set) are skipped, so re-runs are idempotent.
 * @param {Element} main
 * @param {Function} resolve `(main) => Array<{element, mbox}>`
 * @param {(mbox: string|null, reason: string) => void} refuse
 * @returns {Array<{element: Element, mbox: string}>}
 */
export function discoverSlots(main, resolve, refuse) {
  let entries;
  try {
    entries = resolve(main);
  } catch {
    refuse(null, 'resolver-failed');
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const valid = [];
  const seen = new Set();
  entries.forEach((entry) => {
    const element = entry?.element;
    if (!element || element.nodeType !== 1 || element === main || !main.contains(element)
        || seen.has(element)) return;
    seen.add(element);
    if (typeof entry.mbox !== 'string' || !MBOX_PATTERN.test(entry.mbox)) {
      if (!element.hasAttribute(STATE_ATTR)) {
        element.setAttribute(STATE_ATTR, 'refused');
        refuse(null, 'invalid-slot');
      }
      return;
    }
    valid.push({ element, mbox: entry.mbox });
  });
  const counts = new Map();
  valid.forEach(({ mbox }) => counts.set(mbox, (counts.get(mbox) || 0) + 1));
  const refused = new Set();
  return valid.filter(({ element, mbox }) => {
    if (counts.get(mbox) > 1) {
      if (!element.hasAttribute(STATE_ATTR)) element.setAttribute(STATE_ATTR, 'refused');
      if (!refused.has(mbox)) refuse(mbox, 'duplicate-mbox');
      refused.add(mbox);
      return false;
    }
    return !element.hasAttribute(STATE_ATTR);
  });
}

/** Puts the slot identity (class token + attribute) on an element. */
export function stampIdentity(element, mbox) {
  element.classList.add(mbox);
  element.setAttribute(SLOT_ATTR, mbox);
}

/**
 * Removes any slot identity a variant fragment inherited from the default it was copied from:
 * identity always comes from the page, never from the fetched markup.
 */
export function stripIdentity(root) {
  root.querySelectorAll('*').forEach((element) => {
    [...element.classList].filter((token) => MBOX_PATTERN.test(token))
      .forEach((token) => element.classList.remove(token));
    if (element.getAttribute('class') === '') element.removeAttribute('class');
    [...element.attributes].map(({ name }) => name)
      .filter((name) => name.startsWith('data-om-'))
      .forEach((name) => element.removeAttribute(name));
  });
}
