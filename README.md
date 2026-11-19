# Compression Dictionary Toolkit

Send smaller JavaScript and CSS updates by reusing bytes the browser already has.

The library provides core APIs and a CLI to prepare dictionary-compressed assets and retain previous versions as dictionaries, a Vite plugin to automate this during builds, and Node and Web API handlers to serve the results. The handlers negotiate compression with the browser and fall back to ordinary Brotli, gzip, or uncompressed files when needed; no client-side JavaScript library is required.

The browser downloads v1 normally. A `Use-As-Dictionary` response header lets it retain those decoded bytes. When it requests v3, it can announce its v1 dictionary; the server sends v3 compressed using that base when worthwhile. The browser reconstructs the complete v3 file, which can become its next base. No separate dictionary download is required by the default flow.

Read [how it works](docs/how-it-works.md) for plain-language examples and history/fallback behavior.

## Install

```sh
npm install compression-dictionary-toolkit
```

One ESM package includes the core, Vite plugin, Node server, Web API handler, and `shared-dict` CLI, with TypeScript declarations. Node 22.12+ is required for the Node modules. Vite 7 or 8 is an optional peer dependency: install it in projects using the plugin; server-only installations do not install Vite.

Build-time compression requires Zstandard 1.5.5+ and Brotli with dictionary support. The toolkit does not bundle these executables. Serving already prepared files requires neither encoder. See [installation](docs/installation.md).

| Import                                  | Purpose                                                               |
| --------------------------------------- | --------------------------------------------------------------------- |
| `compression-dictionary-toolkit`        | Prepare dictionaries, representations, history, and manifests         |
| `compression-dictionary-toolkit/vite`   | Prepare final Vite JS/CSS automatically                               |
| `compression-dictionary-toolkit/server` | Serve prepared output through Node                                    |
| `compression-dictionary-toolkit/edge`   | Serve exported objects through Web APIs, without Node runtime imports |

## Use with Vite and Node

The Vite build:

```js
import { defineConfig } from 'vite';
import sharedDictionary from 'compression-dictionary-toolkit/vite';

export default defineConfig({
    plugins: [sharedDictionary({ storeDir: '.dictionary-store', historyLimit: 3 })],
});
```

The Node server:

```js
import { createDictionaryServer } from 'compression-dictionary-toolkit/server';

createDictionaryServer({
    root: './dist',
    allowInsecureLocalhost: true, // Local demo; use HTTPS for deployment.
}).listen(3000, '127.0.0.1');
```

Deploy all of `dist`, including `.cdt`. Preserve the build store between releases. Default asset delivery uses a one-year immutable cache policy: **changed bytes must get new hashed or versioned URLs**. For fixed URLs requiring revalidation, use `dictionaryDelivery: 'separate'`. See [adoption](docs/adoption.md) and [dictionary policy](docs/dictionary-policy.md).

For custom build scripts, use [the core functions](docs/api.md). Existing HTTP servers can use `createRequestHandler`; Web API runtimes can import `createEdgeHandler` from `compression-dictionary-toolkit/edge`. See the [server guide](docs/server-and-deployment.md) and [export format](docs/deployment-protocol.md).

## Run the interactive playground

Clone this repository and use Node 24 (`nvm use`) for development:

```sh
# macOS encoder tools
brew install zstd brotli
npm ci
npm run demo
```

Open **http://localhost:4173**. The command builds four product versions and starts the demo site and backend.

1. The site loads product v1 with and without shared dictionary compression.
2. Click **v2**, then **v3**, without loading the product in between. These buttons change the active backend version.
3. Click **Load product & compare**. Both previews load v3; the shared path can reuse v1.
4. Compare encoded bytes, ready times, individual requests, and visit history. Export the measurements as JSON if needed.

In DevTools Network, keep **Disable cache unchecked**, enable Preserve log, and filter by `product-`. Inspect the browser-generated `Available-Dictionary` and the response's `Content-Encoding` / `Use-As-Dictionary`.

For already built versions, use `npm run demo:serve`. The [walkthrough](docs/local-browser.md) explains cold visits, skipped releases, warm repeats, and timing limits.

| Path                    | Role                                            |
| ----------------------- | ----------------------------------------------- |
| `src/core/`             | Build-time preparation and CLI                  |
| `src/vite/`             | Vite integration                                |
| `src/server/`           | Node and Web API delivery                       |
| `playground/product/`   | Catalog product built into v1–v4 JS/CSS         |
| `playground/site/`      | Host site, controls, previews, and measurements |
| `playground/server.mjs` | Demo routing and release selection              |
| `examples/compose.mjs`  | Core example for manually assembled outputs     |

The host site and product are served on one origin so native dictionary support can be observed without cross-origin configuration. Normal and dictionary paths deliver the same decoded files. The baseline path is outside dictionary match patterns.

## Verification and release

`npm test` covers core, plugin, Node/edge, and backend controls. `npm run test:browser` drives the actual version/load buttons in Chromium and checks native headers, decoded bytes, displayed measurements, export, and mobile layout.

`npm run pack:release` creates and checks one tarball, `artifacts/npm/compression-dictionary-toolkit-0.2.0.tgz`. It tests an isolated installation without Vite, checks publication metadata against a local registry, and creates a matching publish directory at `artifacts/npm/package/`. It does not publish to npm. See [releasing](docs/releasing.md).

The [standalone consumer](examples/package-consumer/README.md) tests the published package and local release candidates through real Vite builds, Node/edge delivery, CLI, types, and native browser dictionaries. See [CHANGELOG.md](CHANGELOG.md) for release notes.

See [CONTRIBUTING.md](CONTRIBUTING.md) for all checks and [verification](docs/verification.md) for results and limits. The demo uses synthetic data; localhost timings do not predict production speedups. Measurements do not isolate browser decompression CPU time.

Licensed under the [MIT License](LICENSE), copyright Marco Prontera.
