# Add shared dictionaries to an application

The integration has three parts: the product build prepares files, the server handler selects a representation, and the host site loads the product normally.

## 1. Build the product with Vite

```js
import { defineConfig } from 'vite';
import sharedDictionary from 'compression-dictionary-toolkit/vite';

export default defineConfig({
    base: '/product/',
    plugins: [sharedDictionary({ storeDir: '.dictionary-store', historyLimit: 3 })],
});
```

The plugin prepares final JavaScript and emitted CSS, ordinary fallbacks, and dcb/dcz variants. It writes `dist/.cdt/manifest.json`. Keep the store outside the output and preserve it between builds, including in CI.

Default asset delivery uses rolling bases and long-lived immutable responses. Keep Vite's hashed filenames. A changed file must get a new URL. CSS and JavaScript have separate families.

Use `dictionaryDelivery: 'separate'` when deliberately keeping mutable URLs that must revalidate, or choosing a fixed stable base. See [dictionary policy](dictionary-policy.md).

## 2. Serve the output with the server handler

```js
import { createDictionaryServer } from 'compression-dictionary-toolkit/server';

createDictionaryServer({
    root: './dist',
    base: '/product/',
    allowInsecureLocalhost: true,
}).listen(3000, '127.0.0.1');
```

The localhost option is for local tests. Use HTTPS for deployment; the [server guide](server-and-deployment.md) covers TLS and trusted proxies. Match the public base to Vite's configuration.

Deploy the complete output, including hidden `.cdt` files. Runtime serving needs no encoders or build store. The package handles negotiation, dictionary advertisements, integrity checks, ETags, Vary, HEAD, and ordinary fallback.

For an existing Node application, use `createRequestHandler(options)` as the request listener for the relevant routes. For Web API runtimes, import `createEdgeHandler` from `compression-dictionary-toolkit/edge` and supply the [exported objects and manifest](deployment-protocol.md).

Upload all required files before activating a release. Retain old hashed URLs for open tabs and late-loaded chunks.

## 3. Load the product on the site

Reference the emitted JS/CSS URLs from the current build. No dictionary-preparation JavaScript is required:

```html
<link rel="stylesheet" href="/product/assets/product-CSS_HASH.css" />
<script src="/product/assets/product-JS_HASH.js"></script>
```

Use the actual URLs emitted by your build and the script type it requires. The sample playground product has one self-contained script; an ESM product needs `type="module"`.

On a first visit, the server sends ordinary compression with `Use-As-Dictionary`. The browser may retain the decoded bytes as a base. A returning browser can announce that base through `Available-Dictionary` and receive the new file compressed using it. The application receives the complete decoded file.

Browser support, dictionary storage, and eligibility vary. Ordinary fallbacks remain necessary. A successful response alone does not prove that the browser has made its dictionary available yet.

## Validate the integration

Run `npm run demo` for a complete product/site/backend example. Its version buttons change the active backend release independently of product loading. Compare cold and returning visits, including v1→v3, using the [browser walkthrough](local-browser.md).

For a staging origin:

```sh
npm run check:deployment -- --origin=https://app.example --manifest=release/edge-manifest.json
```

This constructs HTTP requests to check bytes and cache separation. Pair it with a native browser test that observes genuine dictionary headers.

The existing server chooses the smallest equally preferred acceptable representation. Measure update bytes and browser timings before adding more optimization policies; the playground reports observed timings and does not estimate isolated decompression CPU cost.
