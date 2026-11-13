# Deployment artifact contract

The browser uses RFC 9842. This document describes the project's convention for connecting builds, storage, and adapters; it does not add HTTP headers to the protocol.

| Component                     | Responsibility                                                             |
| ----------------------------- | -------------------------------------------------------------------------- |
| Build                         | Select bases; generate variants and fallbacks; calculate sizes and digests |
| Object storage / internal CDN | Keep immutable objects addressed by their content                          |
| Server or Worker              | Read request headers, select an existing variant, and set response headers |

A variant is logically identified by `(asset hash, dictionary hash, encoding)`. Its storage object is identified by the hash of the actual encoded bytes, so changing encoder settings does not overwrite old objects.

Use `createEdgeHandler` from `compression-dictionary-toolkit/edge` to consume the exported manifest and objects. The entry point is independent of Node runtime modules.

## Export for a Worker

Run after Vite and any composition scripts:

```sh
npx shared-dict export --out-dir ./dist --target-dir ./release --release-id build-123
```

```js
import { exportRelease } from 'compression-dictionary-toolkit';
await exportRelease({ outDir: './dist', targetDir: './release', releaseId: 'build-123' });
```

For a Vite base such as `/app/`, also pass `base: '/app/'` or `--base /app/`. Source and target directories must be separate, with neither containing the other. Export checks their physical paths before writing objects or metadata, including symlink aliases and existing ancestors of a new target directory. Use a fresh export directory per release to avoid retaining unreferenced outputs.

Exports sharing a physical target directory are serialized within a process. A competing process fails with `Export is busy` while the target's `.write.lock` is held, preventing mixed manifests and upload plans. After a crash, remove that lock only after confirming that no export is active.

| Output                         | Destination                                             |
| ------------------------------ | ------------------------------------------------------- |
| `release/objects/<sha256>.bin` | Object storage; opaque bytes without `Content-Encoding` |
| `release/edge-manifest.json`   | Bundled with the Worker, not a public page              |
| `release/upload-plan.json`     | Object inventory and upload metadata for CI             |

The manifest records `schemaVersion: 1`, `kind: "shared-dict-release"`, `releaseId`, `assets`, `dictionaries`, and `staticFiles`. Representations contain an object path, size, and SHA-256. Other public output files, such as HTML, UI scripts, and images, are included. Hidden directories are excluded; required `.cdt` files are exported explicitly. Keep private material outside the public output directory.

Static filenames may contain spaces, Unicode, `@`, or literal `%` characters. Export encodes each URL path segment once, and the edge handler recognizes equivalent request encodings after checking for traversal and hidden paths. For example, `logo@2x.svg` and `logo%402x.svg` request the same file; a file literally named `logo%20light.svg` uses `logo%2520light.svg`, distinct from `logo light.svg`. Control characters and backslashes remain invalid public filenames. Prepared asset URLs, dictionary URLs, and match patterns retain their existing validation and exact manifest routing.

Storage serves compressed objects as opaque bytes. The edge handler verifies their digests and sets `Content-Encoding` only on the final browser response. An internal object cache can cache each object at its own URL without understanding the browser's dictionary negotiation.

Assets record `dictionaryDelivery`. With `asset`, `dictionaryHash` must equal the asset hash, policy is rolling, and the current dictionary record describes the decoded response. The adapter sends `Use-As-Dictionary` on that response. With `separate`, it sends a dictionary `Link` instead. Missing delivery fields in older manifests mean separate delivery; do not infer delivery from `dictionaryPolicy`.

## Activation and caching

Upload and verify all objects before deploying the Worker with its manifest. A failed upload must prevent activation. Export itself does not modify any cloud account.

The Worker selects on every request and sends `Cloudflare-CDN-Cache-Control: no-store`; it does not put negotiated responses in the Cache API. It retains `Vary` for downstream caches. Internal object caches may cache by content hash. Do not override this with a public response cache that ignores negotiation.

Browser cache policy is distinct from the internal object/CDN policy. Asset delivery defaults to `public, max-age=31536000, immutable`: use a new public URL for every changed JS/CSS file. Keep HTML revalidating to discover new URLs. Separate delivery defaults to revalidating asset responses and long-lived dedicated dictionaries.

The Node server reads `dist/.cdt/manifest.json` directly. See [server integration](server-and-deployment.md) for the origin-server arrangement.

## Current limits

The Worker reads and verifies a whole object in memory. It does not provide streaming, SPA routing, authentication, or dynamic manifest loading. Its bundled manifest must fit the selected platform's limits.

A manifest describes one release. Keeping old blobs does not preserve URLs absent from the current manifest. Applications with late-loaded chunks need their own retention or route-merging policy. Automatic object cleanup is not implemented.

Rollback reactivates the previous Worker/manifest and its retained objects. Fixed-name assets still follow their revalidation policy.
