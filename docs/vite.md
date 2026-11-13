# Vite integration and composition

The plugin handles the build step: after Vite finishes a JavaScript or CSS file, it saves or reuses a dictionary and prepares compressed responses. Your server selects those responses later, and the browser decodes them. Start with [how it works](how-it-works.md) for the concept or [adoption](adoption.md) for the complete build-to-browser setup.

Install `compression-dictionary-toolkit` in your Vite project and import the plugin from `compression-dictionary-toolkit/vite`. Vite 7 or 8 must be installed by the application; it is an optional peer so server-only consumers do not receive it. For local testing before publication, run `npm run pack:release` here and install the generated tarball in the consuming project.

## Automatic preparation

```js
import { defineConfig } from 'vite';
import sharedDictionary from 'compression-dictionary-toolkit/vite';

export default defineConfig({
    plugins: [
        sharedDictionary({
            storeDir: '.dictionary-store',
            dictionaryDelivery: 'asset',
            historyLimit: 3,
            level: 10,
            brotliQuality: 9,
            concurrency: 2,
        }),
    ],
});
```

In this example, `storeDir` is the build's memory of previous bases. Each requested asset becomes a base, and `historyLimit: 3` prepares responses using the current and two previous distinct bases per family. No extra dictionary download is needed. `level` and `brotliQuality` control compression effort; you can leave them at their defaults while learning the workflow.

The default cache policy is `public, max-age=31536000, immutable`. Keep Vite's hashed filenames, including for workers; changed bytes must get new URLs. If you deliberately use fixed filenames that revalidate, configure `dictionaryDelivery: 'separate'`. The server must emit the manifest's advertisement headers as well as select compressed responses.

The plugin runs only during `vite build`. It reads the resolved configuration, collects emitted outputs in `writeBundle`, and prepares them as a bounded core batch in a post-ordered `closeBundle` hook. The hook remains sequential relative to other plugin hooks; asset compression inside it runs in parallel. See the [Vite Plugin API](https://vite.dev/guide/api-plugin).

`concurrency` controls how many assets are prepared together (1–16). The default is half the CPUs available to the process, rounded down and limited to 1–4. Each asset can run two encoders at once. Set `concurrency: 1` to limit preparation to one asset at a time; the example uses two. Selection of shared bases follows emitted-file order, regardless of encoder completion order. The batch publishes its new registry and manifest only after all encoders succeed. Existing exclusion and public-file invalidation checks run before that batch.

To measure your runner, use `npm run benchmark -- 1 4` in this repository. It compares one and four concurrent assets using generated public data, one warm-up and three measured runs, reporting separate medians for the core and full Vite builds. It uses real Brotli/Zstandard encoders. Results depend on CPU allocation, input size, and compression settings; more concurrent assets are not always faster.

Relative `storeDir` paths resolve against the Vite root. The plugin reads emitted, minified JavaScript and CSS from disk, rather than uncompiled TypeScript sources. It prepares both dcb and dcz for each retained base, plus ordinary fallbacks. Set `brotliBinary` / `zstdBinary` or `BROTLI_BIN` / `ZSTD_BIN` for custom encoders.

The store must be outside the output directory, including through symlink aliases. The output must also be separate from `storeDir/dictionaries`; using that dictionary directory as the output would otherwise delete persistent bases on a rebuild. The plugin validates both conditions during configuration, before Vite can clear the output.

During configuration the core also rejects `storeDir/dictionaries` or `outDir/.cdt` aliases that point outside their configured roots. Its subsequent writes and metadata reads enforce the same confinement. Root aliases remain supported; keep the workspace and configured codec executables under trusted build control.

The root `.cdt` path is reserved for generated metadata and cannot appear in `publicDir` when public copying is enabled. The plugin rejects it before Vite clears or copies output files. For retained preparations, copied asset checks validate manifest paths, resolve symlinks within the public and output roots, and hash regular output files in chunks. Disabling `publicDir` or `build.copyPublicDir` also disables these public-copy checks.

Set the output directory through `build.outDir`. If `build.rolldownOptions.output` (or `build.rollupOptions.output`) explicitly sets `dir`, every output must resolve to that same directory. Use an absolute path when the Vite root differs from the process directory. Mismatched overrides, including entries in an output array, are rejected during configuration before Vite can clean directories or overwrite files. Multiple formats sharing the same output directory are collected across all bundler passes and prepared together when the build closes.

Standard Vite chunk and stylesheet names produce stable patterns such as `/assets/app-*.js` and `/assets/app-*.css`; a fixed name uses its exact path. JS and CSS use separate families by default. Custom naming conventions may need `resolveAsset`. Only emitted CSS files are processed: styles inlined into HTML or injected by JavaScript do not produce a separate CSS dictionary.

Web Worker and SharedWorker chunks retain their logical names across builds, including names containing dots and custom output directories or hash lengths using the `[name]-[hash].js` convention. The plugin collects worker compilation metadata while preserving your existing `worker.plugins`. A fixed worker filename keeps an exact match. Other nameless assets keep exact URLs unless configured through `resolveAsset`.

Earlier builds used exact hashed worker URLs as separate families. The first rebuild with this fix establishes a stable worker family; subsequent builds reuse its base according to the configured dictionary policy.

Prepared JS/CSS also work with dot-prefixed output directories such as `build.assetsDir: '.assets'`: Node and edge resolve their public URLs through the manifest. Other hidden files, including excluded or empty outputs without a manifest entry, remain private; use a regular directory for ordinary static assets.

Empty JS/CSS outputs are served as ordinary files and do not become dictionaries. If an emitted output is now empty, excluded by `exclude`, or skipped by `resolveAsset`, its previous manifest entry is removed even with `emptyOutDir: false`. This prevents the server from selecting stale compressed bytes after a rebuild. Other assets and the persistent dictionary history are retained.

Files copied from `publicDir` are not automatically prepared. When a copied file overwrites a prepared asset with different bytes, the plugin removes the stale preparation before completing the build, including with `emptyOutDir: false`. Unchanged preparations and stored dictionary history are preserved. This check respects custom `publicDir` paths, `publicDir: false`, and `build.copyPublicDir: false`.

A successful build with no emitted JS/CSS, such as an HTML-only site, initializes an empty manifest so the Node server and release exporter can still use the output. Existing preparations are preserved when retaining output files, except those invalidated by a public file overwrite. Builds with `write: false` and builds that fail before writing do not initialize a manifest.

Dots within logical names are preserved: a JavaScript chunk named `my.app` uses `/assets/my.app-*.js`. Earlier code incorrectly removed the final dotted segment, creating a new family whenever the filename hash changed. For affected chunks using automatic families, the first build with this fix establishes a new stable family and base; subsequent builds reuse it. Explicit `resolveAsset` families are unchanged.

## Explicit asset families

```js
sharedDictionary({
    exclude: (fileName) => fileName.startsWith('pieces/'),
    resolveAsset: ({ fileName, defaults }) => {
        if (fileName.endsWith('.css')) {
            return { key: 'theme', match: '/assets/theme-*.css' };
        }
        if (fileName.startsWith('assets/app-')) {
            return { key: 'app', match: '/assets/app-*.js' };
        }
        return defaults;
    },
});
```

`resolveAsset` receives `fileName`, `url`, `item`, and `defaults`. Return overrides, `false` to skip, or `undefined` to keep defaults. `exclude` receives the output filename relative to `outDir`.

Use one key per related family. Under `stable`, chunks sharing a key use the first base of that epoch; under `rolling`, their versions compete for `historyLimit`. Keep match patterns specific enough that the base selected by the browser has a corresponding prepared variant, or the server must fall back.

`resolveAsset` can also return `dictionaryInput: './compression-bases/app.js'`, resolved against the Vite root. Set `dictionaryPolicy` and `dictionaryEpoch` on the plugin. See [dictionary policy](dictionary-policy.md).

## Manual composition

The optional [core composition example](../examples/compose.mjs) works after your own build steps:

1. Build two independent IIFEs without the plugin into a parts directory.
2. Concatenate them, hash the final bytes, and write `fixed/composed-<hash>.js`.
3. Call `prepareAsset` once on the final bytes, with match `/fixed/composed-*.js`.

The default playground uses only the automatic Vite product flow. Manual composition is kept separate so it does not obscure the product/site/server example.

The IIFEs have independent scopes and a semicolon separator. Do not blindly concatenate ESM chunks, imports, or source maps. Use a bundler for the final composition when needed. Exclude intermediate outputs from the plugin, or use separate builds. If another script changes an output afterward, call `prepareAsset` again after that script.

## Supported configurations

Client builds with one output directory and an absolute same-origin base, such as `/` or `/app/`. SSR, relative or cross-origin bases, and multiple output directories in one build are rejected. The plugin does not intercept HMR or configure `vite preview`; use `compression-dictionary-toolkit/server` to test negotiation.

When using a base such as `/app/`, pass the same `base` to the [Node server](server-and-deployment.md) so HTML and other public files are served under that prefix.

The declared peer range includes Vite 7 and 8, but the lockfile pins Vite 8.3.5. The demo uses Vite 8's `rolldownOptions`; Vite 7 uses `rollupOptions`. See [verification](verification.md) for actual test coverage rather than treating the peer range as a test result.
