# Contributing

Use Node 24 (`nvm use`) for development. Repository tooling supports Node 22.13+ on the 22.x line, or Node 24 and newer; the published package requires Node 22.12 or newer. Install npm dependencies and the Brotli/Zstandard tools described in [installation](docs/installation.md).

```sh
npm ci
npm run lint
npm run format:check
npm run doctor
npm test
npm run check:types
npm run check:packages
```

Run `npm run format` to format source code, tests, configuration, and documentation, and `npm run lint:fix` to apply available ESLint fixes. Prettier uses the same style as `vite-plugin-css-injected-by-js`: four-space indentation, single quotes, semicolons, and a 120-character print width. ESLint uses the recommended JavaScript and TypeScript rules, with globals scoped to Node, browser, and worker code. Both checks run in CI on Node 22 and 24.

Generated artifacts, dependencies, and `learning/` are excluded from both tools. Prettier also leaves `package-lock.json` to npm.

Provider-specific guides in `docs/deploy/` are local-only material excluded from Git, ESLint, and Prettier. Keep shared tests and public documentation independent of that directory so a clean checkout works without it. The generic edge handler is exported through `compression-dictionary-toolkit/edge`.

`check:packages` packs the root package and installs its tarball into an isolated project offline with normal peer resolution. It checks contents, licensing, all four entry points, the CLI, and that Vite is not installed. It also checks that the server does not load build modules and that edge imports and declarations work without Node dependencies. Vite integration tests cover actual builds. Run `npm run pack:release` for the same checks and a retained archive, matching publish directory, and inventory in `artifacts/npm/`. Publication metadata is tested against a loopback-only registry; no package is sent to npm. The [standalone consumer](examples/package-consumer/README.md) exercises registry installations and release candidates.

For changes to build output, dictionary policy, or serving behavior, also run:

```sh
npm run demo:cycle
npm run demo:inspect
npm run demo:export
npx playwright install chromium
npm run test:browser
```

Stop the demo server before running `demo:cycle`. Browser tests must observe real browser-generated dictionary headers; do not simulate support by injecting headers. The standard tests need permission to open local listening sockets. Encoder or environment failures are not passing test results.

Keep code, messages, tests, and documentation in English. Add focused regression coverage for behavior changes. Avoid committing generated dictionaries, demo builds, browser profiles, certificates, or local configuration. Check `git status` before committing.

The core prepares bytes and metadata at build time. The server selects prepared responses at request time through its Node and Web API entry points. Core, plugin, and server are internal modules of one published package. Keep entry points independent: serving must not load build code, and edge must not load Node modules or require Node declarations. The playground product, host site, and version controls consume the public package imports. Preserve fallback behavior and update declarations when changing APIs.

For pull requests, describe the observable problem, the change, and the checks performed. Mention anything you could not verify. Release preparation is documented in [releasing](docs/releasing.md).
