# Core API

The APIs are asynchronous ESM functions with TypeScript declarations and no Vite dependency. `createDictionary` does not require encoders; `prepareAsset` requires both Zstandard and dictionary-capable Brotli. See [installation](installation.md).

## `createDictionary(options)`

```js
import { createDictionary } from 'compression-dictionary-toolkit';

const dict = await createDictionary({
    input: './build/output.css',
    storeDir: './.dictionary-store',
    key: 'theme',
    match: '/assets/theme-*.css',
});
```

This stores raw bytes and updates history. The result includes hexadecimal `hash`, formatted `availableDictionary`, absolute `path`, `bytes`, `key`, `match`, and the initial registration time. It does not start a server or publish a URL.

| Option     | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `input`    | Path to a `.js`, `.mjs`, `.cjs`, or `.css` file                                |
| `storeDir` | Persistent directory; defaults to `.dictionary-store`, relative to the process |
| `key`      | Stable family identifier, up to 100 alphanumeric or `_.-` characters           |
| `match`    | Absolute same-origin path, optionally containing `*` wildcards                 |

## `prepareAsset(options)`

```js
import { prepareAsset } from 'compression-dictionary-toolkit';

const asset = await prepareAsset({
    input: './dist/assets/app-XYZ.js',
    outDir: './dist',
    storeDir: './.dictionary-store',
    key: 'app',
    url: '/assets/app-XYZ.js',
    match: '/assets/app-*.js',
    dictionaryDelivery: 'asset',
    historyLimit: 3,
});
```

The default asset delivery uses rolling policy: each changed file becomes the current base. Its normal response carries `Use-As-Dictionary`, so a supporting browser can retain the decoded bytes without a separate download. Preparation creates identity/br/gzip and dcb/dcz variants for each selected base, copies publishable dictionaries, and updates `.cdt/manifest.json`. The server needs only `outDir`, not the build store or encoders. Encoder failure leaves the new manifest and history unpublished.

| Additional option    | Default                                             | Meaning                                                                               |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `outDir`             | `dist`                                              | Deployable directory                                                                  |
| `url`                | Required                                            | Public asset URL without a query                                                      |
| `match`              | `url`                                               | Pattern covering future versions                                                      |
| `dictionaryDelivery` | `asset`                                             | Reuse decoded asset responses; `separate` advertises a dedicated URL                  |
| `dictionaryPolicy`   | `rolling` in asset mode; `stable` in separate mode  | Register each version, or keep a base until rotation                                  |
| `dictionaryEpoch`    | `v1`                                                | Stable base identity; change to rotate                                                |
| `dictionaryInput`    | First input of the epoch                            | Fixed JS/CSS base, including with an empty store                                      |
| `historyLimit`       | 1 for stable, 3 for rolling                         | 1–20 bases, including the active base                                                 |
| `level`              | 10                                                  | Zstandard compression level, 1–19                                                     |
| `zstdBinary`         | `ZSTD_BIN` or `zstd`                                | Zstandard executable                                                                  |
| `brotliQuality`      | 9                                                   | Shared Brotli quality, 0–11                                                           |
| `brotliBinary`       | `BROTLI_BIN` or `brotli`                            | Dictionary-capable Brotli executable                                                  |
| `dictionaryBase`     | `/__dictionaries/`                                  | Dictionary URL prefix ending in `/`                                                   |
| `cacheControl`       | `public, max-age=31536000, immutable` in asset mode | Asset response policy; separate mode defaults to `public, max-age=0, must-revalidate` |

Asset delivery requires URLs that change with content and a cache policy permitting dictionary reuse. It rejects `no-cache`, `no-store`, and policies without positive freshness or an allowed stale-while-revalidate window. Explicit `dictionaryPolicy: 'stable'` or `dictionaryInput` selects separate delivery when delivery is omitted; an explicit asset/stable combination is rejected. See [policy and migration](dictionary-policy.md).

The result includes representation paths and sizes, `dictionaryUrl`, `dictionaryHash`, `dictionaryDelivery`, `dictionaryPolicy`, the stable epoch when applicable, and `dcb` / `dcz` maps indexed by dictionary hash. `asset.hash` identifies the current asset; it equals `dictionaryHash` in asset mode and can differ in separate mode. Each variant records `file`, `bytes`, its representation `hash`, and `dictionaryUrl`.

`readManifest(outDir)` reads the complete index. For older dcz-only manifests it supplies an empty dcb map. Rebuild with both encoders to add dcb, preserving the store. Manifests without `dictionaryDelivery` retain separate delivery, even when their policy was rolling.

All manifest consumers validate stored paths, SHA-256 hashes, byte counts, and dictionary references before using the records. Original asset paths must be relative and cannot contain traversal segments or backslashes. Representation and dictionary paths must remain in `.cdt/variants/` and `.cdt/dictionaries/`, respectively. Missing integrity fields are rejected; legacy dcz manifests and older filenames within these directories remain supported.

If `input` is outside `outDir`, the core copies it to the path corresponding to `url`. Otherwise it uses the existing asset. Serving uses immutable representation copies from the manifest so that updated source files are not paired with stale representation metadata.

Original assets and copied destinations cannot use the reserved root `.cdt` directory, including case variants and symlink aliases. Preparation rejects these paths before writing dictionaries or representations, so an original cannot overwrite a manifest, lock, or previously published object.

Compressed representation paths include the hash of their wire bytes. Upgrading Node or an encoder can produce different compressed bytes for the same input without overwriting files referenced by another asset or an earlier manifest. Older manifest paths remain readable; consumers should use the recorded `file` rather than construct a representation path.

## `prepareAssets(assets, { concurrency })`

Use a batch to prepare multiple finished files in parallel:

```js
import { prepareAssets } from 'compression-dictionary-toolkit';

const assets = await prepareAssets(
    [
        { input: './dist/app-v1.js', key: 'app', url: '/app-v1.js', match: '/app-*.js' },
        { input: './dist/theme-v1.css', key: 'theme', url: '/theme-v1.css', match: '/theme-*.css' },
    ],
    { concurrency: 2 }
);
```

Each item accepts the same options as `prepareAsset`. All items must use the same resolved `outDir` and `storeDir`, including their defaults. The returned array follows input order. An empty array returns an empty array without creating files.

`concurrency` limits active assets, from 1 to 16. By default it uses half the CPUs available to the process, rounded down and limited to 1–4 assets. Each asset can run two encoders concurrently, so start with the default on CI runners and reduce it if memory is constrained. `concurrency: 1` prepares one asset at a time.

For example, with four inputs and `concurrency: 2`, two files are prepared together; when one finishes, the next starts. Only those active files keep input buffers in memory. Dictionary selection still follows input order: under `stable`, the first file for a family establishes its base; under `rolling`, each file keeps the history available at its position in the batch. Repeated URLs are published in input order, with the last item winning.

A batch holds the store and output locks once. Compression overlaps, while registry and manifest publication wait for all preparations to succeed. On failure, no further queued work starts after the failure is observed, and active work is awaited before the promise rejects and locks are released. Encoder failure leaves the previous registry and manifest intact; unreferenced dictionary/representation objects may remain. Copied originals are replaced only after successful compression.

Separate calls to `prepareAsset` sharing directories remain serialized. Wrapping those calls in `Promise.all` does not provide this batch speedup; use `prepareAssets` instead.

## `initializeManifest(outDir)`

Create an empty `.cdt/manifest.json` when the output contains only static files. `outDir` defaults to `dist`. The operation uses the output lock and preserves an existing manifest. It requires no encoders or persistent store. The Vite plugin calls it automatically after a successful build that writes no JS/CSS outputs.

## `removePreparedAsset({ outDir, url })`

Remove a public URL from dictionary negotiation so that its current file can be served normally. `outDir` defaults to `dist`; `url` is required. The result is `true` if an asset entry was removed, or `false` if it was already absent.

The operation updates the manifest under the same output lock as preparation and removes only dictionary records that no remaining asset references. It preserves original files, immutable objects, and the persistent store. If there is no manifest, it creates an empty one so an all-static build can still be served or exported. The Vite plugin uses this when an emitted asset is excluded or empty.

## After a manual transformation

```js
const hash = createHash('sha256').update(composedBytes).digest('hex').slice(0, 12);
const url = `/fixed/composed-${hash}.js`;
await writeFile(`./dist${url}`, composedBytes);
await prepareAsset({
    input: `./dist${url}`,
    outDir: './dist',
    storeDir: './.dictionary-store',
    key: 'composed',
    url,
    match: '/fixed/composed-*.js',
});
```

Import `createHash` from `node:crypto` and `writeFile` from `node:fs/promises`, and create the destination directory first. See the executable [composition example](../examples/compose.mjs).

## Codec functions

```js
import { compressDcz, decompressDcz, compressDcb, decompressDcb } from 'compression-dictionary-toolkit';

const dcz = await compressDcz(finalBytes, dict.path, { level: 10 });
const dcb = await compressDcb(finalBytes, dict.path, { quality: 9 });
const originalFromDcz = await decompressDcz(dcz, dict.path);
const originalFromDcb = await decompressDcb(dcb, dict.path);
```

These accept `Uint8Array` / `Buffer` and return `Buffer`. Decoders verify the base digest before invoking the codec. `compressDcz` accepts `level`, expected `hash`, and `zstdBinary`; `compressDcb` accepts `quality`, expected `hash`, and `brotliBinary`. Decoder options accept the corresponding executable path.

The dcz container has a 40-byte prefix; dcb has 36 bytes. Both include the base's SHA-256 digest. This implementation limits the compression window to 8 MiB for Zstandard and 16 MiB for Shared Brotli. Renaming an ordinary `.br` file to `.dcb` does not create a dictionary-compressed HTTP representation.

`decompressDcb` rejects Brotli's large-window extension before starting the native decoder, even if the installed Brotli CLI accepts it. Standard Brotli window encodings remain supported, as required by [RFC 9842, Section 4](https://www.rfc-editor.org/rfc/rfc9842.html#section-4).

## CLI

```sh
npx shared-dict dictionary --input ./dist/app.js --key app --match '/assets/app-*.js'
npx shared-dict prepare --input ./dist/app-v1.js --key app --url /app-v1.js --match '/app-*.js' --out-dir ./dist
npx shared-dict prepare --input ./dist/app.js --key app --url /app.js --dictionary-delivery separate --brotli-quality 9 --brotli-bin /path/to/brotli --zstd-bin /path/to/zstd
npx shared-dict prepare --input ./dist/app.js --key app --url /app.js --dictionary-delivery separate --dictionary-epoch base-2 --history-limit 2
npx shared-dict export --out-dir ./dist --target-dir ./release --release-id build-123
```

Run in a project that has installed `compression-dictionary-toolkit`. When working in this repository itself, replace `npx shared-dict` with `node src/core/cli.js`. `prepare` always generates dcb and dcz. `--dictionary-delivery asset|separate` selects delivery; `--cache-control` overrides the asset cache policy. Commands emit JSON and exit nonzero on failure.

## `exportRelease(options)`

Pass `{ outDir, targetDir, releaseId, base? }`; the result is `{ manifestPath, objects, releaseId }`. Export verifies digests and writes immutable objects plus a private manifest. It includes ordinary public files alongside prepared assets. It performs no upload. See the [deployment protocol](deployment-protocol.md).

Export opens source files without blocking on pipes, rejects nonregular files, and copies regular files in chunks while hashing them. Prepared objects must match both their recorded size and hash. Temporary copies are removed on failure and become content-addressed objects only after verification. Ordinary static files may be empty or larger than the dictionary input limit; they are streamed rather than buffered in full.

## Limits

Inputs must be nonempty and no larger than 8 MiB. Patterns support ASCII letters, digits, `/_.~-`, and `*`, not regular expressions, cross-origin URLs, queries, or advanced URLPattern syntax. A key's match pattern cannot change; use a new key instead. Keep the store outside `outDir`. Preparation checks both configured and physical paths, including symlinked ancestors of directories that do not exist yet, before writing files.

The standalone encoders and decoders apply the same 8 MiB limit to dictionaries. Input and dictionary reads accept regular files only; registry and manifest JSON files are also restricted to regular files, with a 64 MiB limit. Reads check the open file's size before allocating buffers and reject files that grow beyond that size during the read. Pipes and devices cannot hold these reads open indefinitely. `matches(pattern, pathname)` consumes literal segments separated by `*` without regular-expression backtracking.

Managed reads, writes, and lock directories are confined to the physical `storeDir`, `outDir`, or export `targetDir`. Root directory aliases remain supported, but a descendant symlink cannot redirect operations outside its root; dangling symlinks are rejected. This also applies to copied original assets and export objects. Keep these directories under the build's control: validation does not provide isolation from an untrusted process changing filesystem entries concurrently. Explicit source inputs and codec executable paths are trusted configuration, and raw dictionaries must contain public data only.

Custom build scripts that clear their output should call `await validateStoreDirectory({ outDir, storeDir })` first. Import it from `compression-dictionary-toolkit`; it rejects stores inside the output and any overlap between the output and `storeDir/dictionaries`, without creating directories or changing files. Both configured and physical paths are checked, including a symlink on the dictionary directory itself. The Vite plugin runs this check automatically before output cleanup. An output such as `storeDir/build` remains valid when it is separate from the dictionary tree.

Writes sharing a store or an output directory are serialized within a process. `prepareAsset` and `prepareAssets` lock both the store and `outDir/.cdt` for the complete manifest read-modify-write operation, so separate stores can safely prepare different assets into the same output directory. Paths referring to the same directory through symlinks share the same lock. Calls with independent stores and outputs can proceed in parallel.

A family's `key` must keep the same `match` in both the store and the output manifest. Separate stores can share a family when their match patterns agree. A conflicting match is rejected before writing dictionaries, representations, registry updates, or a new manifest; use a different key for a different policy. This also applies to concurrent preparations into the same output.

Concurrent processes sharing either resource fail explicitly with `Store is busy` or `Output is busy`, rather than overwrite history or lose manifest entries. Use one build job per store and output directory. Locks are released on success and failure; after a crash, remove a stale `.write.lock` only after checking that no build is still active. These locks coordinate toolkit calls, not external operations that delete or rewrite build directories, such as Vite's output cleanup.

`exportRelease` also locks its target directory for the entire export. Calls sharing a physical target, including through aliases, are queued within a process; competing processes receive `Export is busy`. The lock covers both `edge-manifest.json` and `upload-plan.json`. Exports to separate targets can proceed independently. Its `.write.lock` has the same crash-recovery rule: remove it only when no export is active.
