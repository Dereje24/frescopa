# Vendored aem-martech

Unmodified copy of <https://github.com/adobe-rnd/aem-martech> (Apache-2.0, see `LICENSE`,
copied verbatim) at commit `37ea8af1ad121105cf00fb399f0996bd73700a60` on the upstream branch
`json-propositions`.

**This revision is UNMERGED.** It is main-based (`1aa3dee3c4791636efa9ad2994342f861c8e149b`,
2026-07-21) and adds the manual `fetchPropositions` API, sharing decision-request and
display protocol builders with the automatic path while keeping their policies separate. It is not
released `main` and does not include upstream PR #17. Re-pin to upstream `main` once the API is
merged.

| File | Upstream path | SHA-256 |
| --- | --- | --- |
| `src/index.js` | `src/index.js` | `8af6822babb50c22628942c7553d59db1d30d90f828adb77b0e507b673382363` |
| `src/alloy.min.js` | `src/alloy.min.js` | `e77362b59c6124f1ab14621fcf508f482ac4b25da49902a731677eea72ec4251` |
| `src/acdl.min.js` | `src/acdl.min.js` | `c8d3a94761576569086cdc65e2bd9bbcfa6ccbf73fe1adf0709f815c684b778c` |
| `LICENSE` | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |

`alloy.min.js` is Adobe Web SDK v2.31.1, self-hosted by upstream; `acdl.min.js` (Adobe Client
Data Layer v3.0.1) is kept so upstream's relative import resolves and is never loaded here
(`dataLayer: false`).

Upstream tests, tooling and history are intentionally not included, and the files are not edited
(`.eslintignore` excludes this directory). This is a plain copy rather than a `git subtree`; update
by re-copying the same paths from a newer upstream commit and changing the pin and hashes above.

Used: `initMartech`, `updateUserConsent` and `fetchPropositions` (which returns
`{ propositions, display }`). Not used: `martechEager`/`martechLazy`/`martechDelayed`, whose
automatic lifecycle would fetch and auto-report propositions before project rendering succeeds.
