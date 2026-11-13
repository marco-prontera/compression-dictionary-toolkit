# Interactive playground

Three parts reproduce a real integration:

```text
product/          Vite product: source → plugin → v1/v2/v3/v4 JS + CSS
site/             Host website: embeds the product and measures visits
server.mjs        Backend: version controls + server handler request handler
```

The playground uses the Node entry point of `compression-dictionary-toolkit/server` implemented in `src/server`. It imports the package as a consumer; it does not implement compression or negotiation itself.

## Start

After [installation](../docs/installation.md):

```sh
npm run demo
```

This builds all four versions and starts **http://localhost:4173**. Alternatively, run `npm run demo:build` once and `npm run demo:serve` afterward.

The site initially loads v1. Publishing with the **v1–v4** buttons changes only the backend's active version. **Load product & compare** then requests that version in both previews. This separation lets a browser stay on v1 while v2 and v3 are published.

State is shared by tabs connected to that backend process and resets to v1 on restart. Versions are prebuilt; buttons never invoke a compiler. Old asset URLs remain routable after switching.

## What is compared?

The shared preview requests `/product/assets/...`; the baseline requests `/baseline/product/assets/...`. Both resolve to the same release files. The baseline disables dictionary encodings and advertisements, and its paths fall outside dictionary match patterns.

Each pair pins one version, uses a fresh request query, and loads the previews sequentially. First delivery alternates between visits. Ordinary response cache hits are avoided while native dictionary storage stays enabled.

The site shows JS/CSS encoded sizes, total preview ready time, per-resource timing, server handling time, encoding, and the base actually used. Export includes the browser's transfer-size estimate and timing breakdowns. It retains the latest 30 pairs.

These are observed browser measurements. Ready time includes preview HTML, measurement code, JS/CSS, and rendering. Decompression CPU time is not measured separately. A repeated current version may use itself as its base; the first load after switching is the useful update comparison.

## Build and inspect

```sh
npm run demo:build -- --version=v3
npm run demo:inspect -- --version=v3
npm run demo:export -- --version=v3
```

Build output: `product/dist/<version>/`. Persistent build history: `.dictionary-store/playground-product/`. Inspection/export default to v4, independently of the running backend's in-memory selection.

Do not rebuild a release while serving its files. Stop the server, rebuild, and restart so the route inventory is refreshed.

See the [browser walkthrough](../docs/local-browser.md), [server guide](../docs/server-and-deployment.md), and [verification](../docs/verification.md).
