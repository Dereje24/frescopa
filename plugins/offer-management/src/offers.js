// Offer Management JSON offer payloads (json-content-item) and per-slot proposition selection.
// Pure functions: no DOM, no network, no logging.

export const JSON_CONTENT_SCHEMA = 'https://ns.adobe.com/personalization/json-content-item';
export const MBOX_PATTERN = /^offer-mgmt-[0-9a-f]{8}$/;
export const OFFER_FRAGMENT = 'om-eds-fragment';
export const OFFER_DEFAULT = 'om-eds-default';
const SUPPORTED_VERSION = 1;
const MAX_URL_LENGTH = 2048;
const MAX_CONTENT_LENGTH = 16 * 1024;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function readContent(content) {
  if (isObject(content)) return content;
  if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) return null;
  try {
    const parsed = JSON.parse(content);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validates one JSON offer against the slot it is meant for.
 * @param {object|string} content the offer JSON (object, or its JSON text)
 * @param {string} mbox the slot's mbox (decision scope)
 * @returns {{kind: 'fragment', url: string, path?: string}|{kind: 'default'}|null} null for an
 *   unknown type/version or an invalid offer (the default stays)
 */
export function parseOffer(content, mbox) {
  const offer = readContent(content);
  if (!offer || offer.version !== SUPPORTED_VERSION || !MBOX_PATTERN.test(mbox || '')) return null;
  if (offer.type === OFFER_DEFAULT) {
    if (offer.mbox !== undefined && offer.mbox !== mbox) return null;
    return { kind: 'default' };
  }
  if (offer.type === OFFER_FRAGMENT) {
    if (offer.mbox !== mbox || typeof offer.url !== 'string' || !offer.url
        || offer.url.length > MAX_URL_LENGTH
        || (offer.path !== undefined && typeof offer.path !== 'string')) {
      return null;
    }
    return { kind: 'fragment', url: offer.url, ...(offer.path && { path: offer.path }) };
  }
  return null;
}

/**
 * Picks the offer for one slot: propositions whose `scope` equals the slot mbox, their
 * json-content-item items in order; the first valid OM offer wins.
 * @param {Array<object>} propositions decision response propositions
 * @param {string} mbox the slot's mbox
 * @returns {{proposition: object, offer: object}|{reason: string}|null} null when no proposition
 *   targets the slot; `{reason: 'unsupported-offer'}` when some do but carry no usable OM offer
 */
export function selectOffer(propositions, mbox) {
  const scoped = (Array.isArray(propositions) ? propositions : [])
    .filter((proposition) => isObject(proposition) && proposition.scope === mbox);
  if (!scoped.length) return null;
  for (let i = 0; i < scoped.length; i += 1) {
    const proposition = scoped[i];
    const reportable = typeof proposition.id === 'string' && proposition.id
      && isObject(proposition.scopeDetails);
    const items = reportable && Array.isArray(proposition.items) ? proposition.items : [];
    for (let j = 0; j < items.length; j += 1) {
      const item = items[j];
      const data = isObject(item) && item.schema === JSON_CONTENT_SCHEMA ? item.data : null;
      if (isObject(data) && (data.format === undefined || data.format === 'application/json')) {
        const offer = parseOffer(data.content, mbox);
        if (offer) return { proposition, offer };
      }
    }
  }
  return { reason: 'unsupported-offer' };
}
