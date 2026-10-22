// Decision request and display reporting through an injected SDK. The runtime never loads Alloy,
// builds identities or manages consent: the host passes an initialized SDK (or a loader for
// one) configured with its own datastream, org and consent.
import { fail } from './render.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function martechAdapter(martech) {
  return {
    async fetch(decisionScopes, { pageURL } = {}) {
      const result = await martech.fetchPropositions({
        decisionScopes, ...(pageURL && { pageURL }),
      });
      if (!Array.isArray(result?.propositions) || typeof result.display !== 'function') {
        throw fail('decision-failed');
      }
      return { propositions: result.propositions, display: result.display };
    },
  };
}

function alloyAdapter(send) {
  return {
    async fetch(decisionScopes) {
      const result = await send({
        type: 'decisioning.propositionFetch',
        renderDecisions: false,
        personalization: { decisionScopes, sendDisplayEvent: false },
      });
      const propositions = result?.propositions;
      if (!Array.isArray(propositions)) throw fail('decision-failed');
      // Snapshot reporting metadata before anything else reads (or mutates) the propositions.
      const metadata = new Map();
      propositions.forEach((proposition) => {
        if (proposition && typeof proposition.id === 'string' && typeof proposition.scope === 'string'
            && proposition.scopeDetails && typeof proposition.scopeDetails === 'object') {
          const { id, scope, scopeDetails } = proposition;
          metadata.set(proposition, clone({ id, scope, scopeDetails }));
        }
      });
      const sent = new Map();
      const display = (proposition) => {
        const meta = metadata.get(proposition);
        if (!meta) return Promise.reject(fail('display-failed'));
        const key = JSON.stringify([meta.id, meta.scope]);
        if (!sent.has(key)) {
          sent.set(key, Promise.resolve().then(() => send({
            xdm: {
              eventType: 'decisioning.propositionDisplay',
              _experience: {
                decisioning: {
                  propositions: [meta],
                  propositionEventType: { display: 1 },
                },
              },
            },
          })));
        }
        return sent.get(key);
      };
      return { propositions, display };
    },
  };
}

/**
 * Wraps a supported SDK:
 * - aem-martech (`json-propositions`): an object with `fetchPropositions({decisionScopes})`
 *   resolving `{propositions, display}`;
 * - a plain Alloy instance: a function called as `alloy('sendEvent', options)`;
 * - any object exposing an Alloy-compatible `sendEvent(options)`.
 * @returns {{fetch: Function}|null}
 */
export function createSdkAdapter(sdk) {
  if (sdk && typeof sdk.fetchPropositions === 'function') return martechAdapter(sdk);
  if (typeof sdk === 'function') return alloyAdapter((options) => sdk('sendEvent', options));
  if (sdk && typeof sdk.sendEvent === 'function') {
    return alloyAdapter((options) => sdk.sendEvent(options));
  }
  return null;
}

/**
 * Requests decisions for the slot mboxes in one call.
 * @param {{sdk?: *, loadSdk?: Function, pageURL?: string}} config
 * @param {string[]} decisionScopes
 * @returns {Promise<{propositions: object[], display: (proposition: object) => Promise}>}
 *   rejects with reason `no-sdk` or `decision-failed`
 */
export async function requestDecisions(config, decisionScopes) {
  let sdk = config.sdk;
  if (sdk === undefined && typeof config.loadSdk === 'function') {
    try {
      sdk = await config.loadSdk();
    } catch (e) {
      throw fail('no-sdk', e);
    }
  }
  const adapter = createSdkAdapter(sdk);
  if (!adapter) throw fail('no-sdk');
  try {
    return await adapter.fetch(decisionScopes, { pageURL: config.pageURL });
  } catch (e) {
    throw e.reason ? e : fail('decision-failed', e);
  }
}
