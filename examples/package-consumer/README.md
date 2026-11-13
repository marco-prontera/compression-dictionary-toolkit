# Published-package consumer

This is a standalone project with its own package.json and lockfile. It installs `compression-dictionary-toolkit@0.1.0` from npm. The checks reject repository self-imports: the toolkit must resolve inside this project's `node_modules`.

The consumer pins Rolldown 1.2.15 to match the repository’s verified Vite toolchain. Use Node 24 and the Brotli/Zstandard executables described in [installation](../../docs/installation.md). From this directory:

```sh
npm ci --registry=https://registry.npmjs.org/
npm test
npx playwright install chromium
npm run test:browser
```

`npm test` builds four synthetic JS/CSS releases using the installed Vite plugin and verifies cold delivery, v1→v3 updates with both dictionary codecs on Node and edge, HEAD/304 responses, v1→v4 fallback after history expiry, CLI export, and TypeScript declarations. The protocol checks construct HTTP headers explicitly; `test:browser` separately checks genuine browser-generated headers, execution, decoded bytes, and zero `.dict` requests.

Outputs and versioned reports are in `test-results/`, ignored by Git. The generated input is readable in `test-results/input/`. Reports contain no absolute paths or account metadata. A test rebuilds only this consumer's generated fixtures.

To view a built version manually:

```sh
npm run build
npm start -- --version=v1 --port=4180
```

Open http://localhost:4180. Stop the server and restart with `--version=v3` on the same port to observe a skipped release. Keep DevTools' Disable cache unchecked.

To test a prepared local release without changing the pinned registry dependency or lockfile:

```sh
npm install --no-save --package-lock=false --ignore-scripts ../../artifacts/npm/compression-dictionary-toolkit-0.2.0.tgz
npm test
npm run test:browser
```

Run `npm ci` afterward to restore the published 0.1.0. The candidate remains unpublished.
