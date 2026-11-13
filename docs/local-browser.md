# Local browser walkthrough

The playground separates the product being released, the site using it, and the backend selecting a response. See [its structure](../playground/README.md) or [how dictionaries work](how-it-works.md).

## Start the product and site

Install the [prerequisites](installation.md), then:

```sh
npm ci
npm run demo
```

The command builds v1–v4 and starts **http://localhost:4173**. Later starts can use `npm run demo:serve` to reuse those builds.

Open a fresh Chrome/Chromium profile for a cold visit. Keep DevTools **Disable cache unchecked** and enable **Preserve log**. The initial page automatically loads v1 in both previews.

The first shared JS/CSS responses use ordinary compression and carry `Use-As-Dictionary`. Their decoded bytes can become the bases for later updates. There is no preparation button and no separate `.dict` download.

## Publish an update

Click **v2**. The backend badge changes to v2 while the product previews remain on v1. No product request is made by this button.

Click **Load product & compare**. The backend's active version is pinned for both previews:

| Preview                   | Behavior                                                    |
| ------------------------- | ----------------------------------------------------------- |
| With shared dictionary    | Browser may announce v1; server may send v2 using that base |
| Without shared dictionary | Same decoded v2, using ordinary Brotli/gzip/identity        |

The shared response advertises decoded v2 as the next base. Dictionary acquisition is asynchronous and storage is browser-controlled; receipt of a response alone does not prove its availability. Inspect the next request's `Available-Dictionary`.

## Skip v2: return when the server already serves v3

Start on a fresh profile with backend v1 and wait for the first visit to finish.

1. Click **v2**, then **v3**, without loading the product between them.
2. Confirm the backend is v3 and the previews are still v1.
3. Click **Load product & compare**.
4. Inspect the first shared requests for v3: they should announce v1 if retained and available.
5. Click **v4**, then load again. The decoded v3 response can supply the next base.

The product uses rolling history 3. A v1 browser can decode v3 directly; no v2 request or intermediate patch is needed. If you jump straight from v1 to v4, v1 is outside v4's prepared history and the shared preview falls back to ordinary compression.

All four releases remain routable, so switching does not break an older product URL.

## Read Network alongside the results

Filter Network by `product-`. The shared path is `/product/assets/...`; the baseline path starts `/baseline/product/assets/...`.

The baseline uses identical decoded bytes but is outside dictionary match patterns and receives no dictionary advertisement.

| Signal                                    | Meaning                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| Request `Available-Dictionary`            | The browser has this exact base                           |
| Response `Content-Encoding: dcb` or `dcz` | The response actually uses dictionary compression         |
| Response `Use-As-Dictionary`              | Its decoded bytes can become a base                       |
| Response `Server-Timing`                  | Optional server instrumentation used by the results table |
| No `.dict` request                        | Expected in the default asset flow                        |

The page does not inject capability headers. The **Dictionary format** selector narrows server candidates to auto, dcb, or dcz; it cannot make an unsupported browser use them. Fallback remains available.

## Understand the measurements

Each comparison loads the two previews sequentially and alternates which runs first. Fresh query parameters cause real JS/CSS transfers without disabling dictionary storage.

- **Body**: `encodedBodySize`, including the dcb/dcz prefix and excluding HTTP headers.
- **Decoded**: `decodedBodySize`, the complete resource size delivered to the browser.
- **Resource time**: each browser Resource Timing entry's duration, including its fetch phases.
- **Server time**: request-handler elapsed time before headers, reported by the server handler.
- **Product ready**: preview navigation through the load event and a subsequent animation frame; includes the preview document, scripts, CSS, and rendering.
- **Export**: JSON for up to 30 recent pairs, including the browser's `transferSize` estimate and time to first byte.

Resource timings follow [Resource Timing](https://www.w3.org/TR/resource-timing/); server metrics use [Server Timing](https://www.w3.org/TR/server-timing/). Transfer size is browser-reported and is not an exact packet capture. The demo does not isolate decompression or JavaScript execution time.

Compare the **first visit after switching versions** for update savings. Loading the same version again may use that version as its own base and produce much smaller warm-repeat responses. Localhost timings are noisy; fewer bytes do not guarantee a faster observed load. The product contains synthetic catalog and CSS data.

For network throttling, apply the same DevTools profile to the whole test and record it alongside the exported report. Use a new browser profile for each independent cold-start scenario; clearing the results does not clear native dictionaries.

## Automated browser test

```sh
npx playwright install chromium
npm run test:browser
```

The script drives the same publish/load buttons and checks cold visits, v1→v2, v1→v3→v4, and v1→v4 history fallback. It compares displayed resource sizes with real response headers, verifies decoded JS/CSS hashes, checks baseline isolation and JSON export, and captures desktop/mobile screenshots. No dictionary capability headers are injected.

Reports are written to `test-results/browser-report.json`; screenshots to `test-results/demo.png` and `test-results/demo-mobile.png`. Use `CHROMIUM_EXECUTABLE=/path/to/browser` to test an installed browser.

## HTTPS and another port

```sh
npm run demo:serve -- --port=4174
npm run demo:serve -- --https
```

HTTPS expects `.cert/localhost-key.pem` and `.cert/localhost.pem`, generated using a trusted local certificate tool such as [mkcert](https://github.com/FiloSottile/mkcert). HTTP on loopback is explicitly enabled only for this local playground. Different schemes, hosts, or ports create different origins.

## Troubleshooting

| Symptom                                     | Check                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| Both paths use br on the first visit        | Expected; a base must first be acquired                                          |
| No dictionary after an update               | Browser support, registration, cache enabled, history retention, matching origin |
| Shared path uses br with an advertised base | Its variant may be absent, disallowed, or larger                                 |
| Backend changed but product did not         | Click Load product; publishing alone makes no product request                    |
| Later comparison uses v3 instead of v1      | The earlier v3 response has become the next base                                 |
| Unexpected old page after changing bytes    | Never overwrite immutable hashed URLs                                            |
| Server cannot start                         | Build all versions with `npm run demo:build`; use a free port                    |
