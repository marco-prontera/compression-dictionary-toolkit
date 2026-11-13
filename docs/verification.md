# Verification and limitations

Run the checks in your own environment before relying on a release. Local HTTP checks and codec round trips do not establish real-browser compatibility or a working cloud deployment.

## Prepared 0.2.0 checks

The local 0.2.0 candidate passed all 187 repository tests, ESLint, Prettier, and TypeScript checks. The standalone consumer passed its protocol/CLI/type checks and four native-browser visits / eight JS/CSS responses after installing the actual candidate tarball. Its lockfile and installed dependency were then restored to published 0.1.0; reports for both versions remain under `examples/package-consumer/test-results/`.

The package check also captured a publication request on a temporary loopback-only registry. It verified that no `_resolved`, `_from`, `_where`, or local home path was submitted, and that the uploaded bytes matched the archive’s SHA-512 integrity. The staged publish directory reproduced that same archive. This check cannot control account identity fields added by the public registry.

Version 0.2.0 is prepared but unpublished. Runtime source and the manifest schema are unchanged from 0.1.0; this release adds consumer verification and publication safeguards. The registry still reports 0.1.0 as latest.

## Published 0.1.0 consumer checks

The registry release was installed in `examples/package-consumer/`, a separate private npm project that rejects repository self-imports. Its protocol and TypeScript checks passed, including JS/CSS cold starts, v1→v3 with dcb/dcz on Node and edge, HEAD/304 behavior, history-expiry fallback, and CLI export. Chromium passed four native-browser visits / eight JS/CSS responses with no injected capability headers or `.dict` requests. Reports are versioned under the consumer’s ignored `test-results/` directory.

The registry metadata for 0.1.0 contains npm account identity fields and an absolute `_resolved` path added by tarball publication. These were absent from the previously audited archive. The 0.2.0 preparation adds directory staging and a local publication-metadata check; it cannot remove metadata already published for 0.1.0.

## Single-package checks

On 2026-11-12, the toolkit was unified as `compression-dictionary-toolkit@0.1.0`. All 187 tests, ESLint, Prettier, and TypeScript checks passed after the move to `src/`.

The package check installs one tarball offline with normal npm peer resolution and confirms that Vite is absent. It exercises all four entry points and the CLI, rejects build-module imports from `/server`, rejects Node runtime imports from `/edge`, and type-checks an edge consumer without Node or Vite declarations. Only source, declarations, package metadata, the README, and the MIT license are included.

## Current playground checks

On 2026-11-12, local checks used Node 24.14.0, Zstandard 1.5.7, Brotli 1.2.0, and Chromium 156.0.8078.4.

- **187 tests passed**, covering core, Vite, the Node/Web API server handlers, release selection, retained URLs, baseline isolation, and optional server timings.
- **13 paired browser visits / 52 JS/CSS responses passed**: cold starts, v1→v2, v1→v3→v4 with auto/dcb/dcz, and ordinary fallback when v1 is absent from v4's prepared history.
- The browser test drives the actual publish/load buttons and reads measurements through the site's JSON export. It checks response bytes against decoded asset hashes and compares displayed sizes with the real response headers.
- Both previews load identical decoded JS/CSS. Baseline URLs do not announce or acquire shared dictionaries. No `.dict` requests or injected capability headers were used.
- Desktop and mobile screenshots were inspected; the mobile page has no horizontal document overflow.

The report is `test-results/browser-report.json`; screenshots are `test-results/demo.png` and `test-results/demo-mobile.png`. These local results do not certify a cloud deployment or predict timings on other devices.

## Historical publication-preparation checks

On 2026-10-30, the imported source was checked on macOS with Node 24.14.0, npm 11.9.0, Zstandard 1.5.7, and Brotli 1.2.0:

| Check                               | Observed result                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP integrity and extraction        | All 69 imported files initially matched the archive                                                                                   |
| Encoder doctor                      | Passed, including Brotli dictionary support                                                                                           |
| Core, stable-policy, and edge tests | 17 passed, including explicit CSS edge negotiation and fallback                                                                       |
| npm package artifacts               | Both core/plugin tarballs passed content, license, isolated offline installation, import, and CLI checks; playground code is excluded |
| JavaScript syntax                   | 33 source/test/script files checked successfully                                                                                      |
| Node HTTP and TLS tests             | 12 blocked at socket setup by sandbox `listen EPERM`, including both new CSS cases                                                    |
| Dependency installation             | Full `npm ci` blocked by DNS/network access; 19 exact lockfile packages recovered from local cache with integrity verification        |
| Vite 8.3.5 integration              | 3 passed using the exact cached dependencies                                                                                          |
| Demo cycle                          | v1–v4 passed, retaining one dictionary per asset family                                                                               |
| Release export                      | v4 exported as 21 immutable objects                                                                                                   |
| Relocated Worker entry point        | Bundled with Vite; no external or Node imports; CSS dcb/dcz and Brotli fallback decoded correctly using exported local objects        |
| Type checking                       | Blocked by incomplete dependency installation: `tsc` is not linked on PATH and the pinned Node type declarations are unavailable      |
| Real-browser test                   | Pending dependencies and an environment allowing a local server                                                                       |
| Cloud deployment                    | Not performed                                                                                                                         |

The archive contained reports from a separate Linux run. Those claims are not counted as results from publication preparation. In particular, the included browser script is not evidence of a completed browser test.

After moving the app, server, and edge implementations into `playground/`, `npm test` ran 32 tests: 20 passed (17 core/policy/edge tests and 3 Vite tests); the 12 HTTP/TLS tests failed at socket setup because this sandbox forbids listening. They remain unverified, rather than passing or skipped. A clean dependency installation remains unverified. The exact locked versions of `@types/node`, `playwright`, and `playwright-core` were unavailable locally. An offline `npm ci --dry-run` passed the updated two-workspace lockfile consistency checks but did not install those packages.

The Worker entry point was bundled and exercised locally against exported objects after its path changed. That check validates relative imports and response bytes; it is not a Wrangler deployment or a Cloudflare runtime test.

## Repeatable checks

```sh
npm ci
npm run doctor
npm test
npm run check:types
npm run check:packages
npm run demo:cycle
npm run demo:inspect
npm run demo:export
npx playwright install chromium
npm run test:browser
```

Run `demo:cycle` with the server stopped. The test suite covers encoding and exact byte reconstruction, stable bases and rotation, history retention, invalid inputs, encoder failure, negotiation preferences, HEAD/304, traversal and symlink handling, edge objects, TLS, Vite output, and manual composition. These are coverage descriptions; consult the command's actual result for pass/fail status.

The TLS test creates an ephemeral certificate with `openssl` and skips that test if OpenSSL is unavailable. It does not modify the system trust store. Browser tests must observe genuine `Available-Dictionary` requests and validate the decoded resource digest.

For a deployed staging origin:

```sh
npm run check:deployment -- --origin=https://app.example --manifest=release/edge-manifest.json
```

Use the matching release manifest. Test both dictionary requests and requests without a usable base on the same public URL, then verify in a browser.

## CSS coverage

The Vite tests change an imported stylesheet between builds and check that its family remains stable while the emitted URL and current base change. Variants using retained older bases remain decodable. They decode both dcb and dcz back to the exact emitted CSS bytes and check that an unchanged rebuild preserves the filename. Node server and edge tests cover CSS MIME types, dictionary matching, both encodings, and ordinary Brotli fallback for visitors without a dictionary.

Run the relevant suites after installing dependencies and encoders:

```sh
node --test test/vite.test.mjs test/server.test.mjs test/edge.test.mjs
npm run demo:cycle
npm run demo:inspect
```

The demo cycle requires one JS and one CSS family in all four product releases, with changing hashes and variants for up to three retained bases. The inspection report includes `/product/assets/product-<hash>.css` and both dictionary encodings. Metadata is in `playground/product/dist/<version>/.cdt/manifest.json`.

For the [manual browser walkthrough](local-browser.md), load v1, publish v2 with the backend button, then choose Load product & compare. Inspect the stylesheet request as well as JavaScript: check `Available-Dictionary`, `Content-Encoding`, `Content-Type: text/css; charset=utf-8`, and the updated page style. The automated browser test checks CSS transfers and the applied `--product-version` custom property. The current browser run is reported above.

## Performance interpretation

The demo uses synthetic data with stable strings and a small number of changes. Report ordinary first visits and HTTP overhead alongside later compressed body sizes. Count a separate base download only for separate delivery. A small v2 delta does not represent the cost of a first visit or predict savings for every application. `demo:inspect` measures the artifacts currently on disk.

## Scope and limits

The core copies complete JS/CSS files as raw bases rather than training on a corpus. Inputs are limited to 8 MiB; windows are 8 MiB for Zstandard and 16 MiB for Shared Brotli. Rolling history defaults to three bases; separate stable mode rotates through an explicit epoch. Neither policy is traffic-driven.

Not implemented: automatic history cleanup, cloud upload, authentication, general CORS configuration, HMR, SSR, and multiple Vite output directories in a build. The included servers load complete objects into memory. The edge adapter does not cache final negotiated responses or automatically route requests to previous releases. The local playground retains all four product releases through its own route map.

Cloud recipes describe integration steps, not certified account configurations. See the [deployment protocol](deployment-protocol.md) for activation and rollback responsibilities.
