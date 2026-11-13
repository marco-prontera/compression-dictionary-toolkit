# Server and deployment

The server's job is to choose an already prepared file. For a request for `app.js`, it looks up the available representations in the manifest, checks which encodings and dictionary the browser can use, and sends a suitable response. It never needs to compress JavaScript during that request. See [how it works](how-it-works.md) for the complete first-visit and update examples.

Import the Node implementation from `compression-dictionary-toolkit/server`. The playground uses that public entry point for product delivery and adds only demo routes and version controls. The same npm package provides the Web API handler through `compression-dictionary-toolkit/edge`. Neither serving entry point loads the Vite plugin or build-time encoders.

## Start from code

```js
import { createDictionaryServer } from 'compression-dictionary-toolkit/server';

const server = createDictionaryServer({
    root: './dist',
    allowInsecureLocalhost: true,
    dictionaryEncodings: ['dcb', 'dcz'],
    logger: (event) => console.log(event),
});
server.listen(4173, '127.0.0.1');
```

`root` can be an async function returning the active release directory. The playground keeps its selected version in memory and changes it through local buttons. Its asset routes remain pinned to their prepared release directories, so old hashed URLs continue to work.

For a Vite build with `base: '/app/'`, pass the same `base` to `createDictionaryServer` or `createRequestHandler`:

```js
const server = createDictionaryServer({ root: './dist', base: '/app/' });
```

`base` defaults to `/` and must be an absolute same-origin path ending with `/`. Static files are mounted under that prefix: `/app/` serves `dist/index.html`, and `/app/logo.svg` serves `dist/logo.svg`. Static requests outside the prefix return 404. Prepared assets and dictionaries keep their absolute manifest URLs, so the default `/__dictionaries/` routes remain available. HEAD, revalidation, and path protections apply under the prefix as well.

Pass `tls: { key, cert }` as buffers for HTTP/2 with HTTP/1 compatibility. Without TLS, dictionaries are disabled unless the explicit localhost option is enabled. That option checks the remote address and request host. The server does not automatically trust `Forwarded` or `X-Forwarded-Proto`; behind a TLS-terminating proxy, secure the internal connection or deliberately adapt the check for your trusted infrastructure.

`createRequestHandler(options)` returns a listener for an existing Node server.

The handler resolves the real release directory once per request, before reading the manifest. If `root` is an active symlink, replacing that symlink atomically affects subsequent requests while in-flight requests continue using the previous directory. Retain the old release until those requests finish. This also applies when the `root` callback returns a symlink.

## Artifacts

| Location                                     | Purpose                                | Lifetime                         |
| -------------------------------------------- | -------------------------------------- | -------------------------------- |
| `.dictionary-store/registry.json`            | Families and base history              | Persistent build state           |
| `.dictionary-store/dictionaries/<hash>.dict` | Raw dictionary bytes                   | Persistent; no automatic cleanup |
| `dist/.cdt/manifest.json`                    | URL-to-representation mapping          | Per release                      |
| `dist/.cdt/dictionaries/<hash>.dict`         | Release dictionaries                   | Deploy with the manifest         |
| `dist/.cdt/variants/<asset-hash>/...`        | Identity, br, gzip, dcb, and dcz files | Deploy with the manifest         |
| `/__dictionaries/<key>/<hash>.dict`          | Public dictionary route                | Resolved through the manifest    |

The server hides `.cdt` and the build store, confines reads to the release directory including symlink checks, and verifies representation integrity. Objects are written before the manifest, which is replaced atomically.

Node and edge handlers accept dot-prefixed public paths when their exact URL is declared in the manifest, such as prepared assets under `/.assets/` or dictionaries under `/.well-known/compression-dictionaries/`. This does not expose other files in those directories: unlisted hidden paths and encoded aliases remain blocked, and traversal checks still apply before routing. The release exporter skips hidden files during ordinary static-file discovery but includes explicitly prepared assets and dictionaries.

Ordinary JS/CSS files retain their executable MIME types when excluded from dictionary preparation, including `.cjs` files and uppercase extensions such as `.JS` and `.CSS`. Node serving and release export both resolve MIME types without case sensitivity.

## Advertising the next base

For `dictionaryDelivery: 'asset'`, both Node and edge add `Use-As-Dictionary` to the requested JS/CSS response. The advertised base is the decoded current asset, even when the response was compressed using an older base. No separate dictionary link is sent. The default cache policy is a one-year immutable lifetime, so changed content must have a new URL.

For separate delivery, the asset response advertises `dictionaryUrl` through a `Link` header. The dedicated dictionary route supplies its bytes with `Use-As-Dictionary`. Existing manifests without a delivery field keep this behavior. Dictionary routes remain available in both modes for explicit use; their existence does not require browser preloading.

Advertisements follow the same origin/transport restrictions as dictionary negotiation. See [policy and cache requirements](dictionary-policy.md).

## Negotiation

The server considers identity/br/gzip and compatible dcb/dcz variants for the exact advertised dictionary hash. It excludes `q=0`, prioritizes quality values, and chooses the smaller representation among equally preferred candidates. A wildcard alone does not enable dictionary encodings. `Dictionary-ID` never replaces digest verification.

Unknown, absent, or malformed hashes exclude dictionary variants. If no representation is acceptable, the server returns 406. GET and HEAD are supported; strong ETags identify the actual representation bytes, including codec and base. Matching validators produce 304.

The shared Node/edge parser accepts a single 32-byte SHA-256 digest in `Available-Dictionary`, using standard Base64 with or without its trailing `=` padding. It compares decoded bytes and tolerates unused non-zero pad bits as described in [RFC 9651](https://www.rfc-editor.org/rfc/rfc9651.html#section-4.2.7). Invalid alphabets, incorrect digest lengths, and multiple hashes do not enable dictionary compression.

Valid Structured Fields parameters, such as `;flag` or `;version=1`, are validated and ignored for dictionary selection. All bare Item parameter types are supported, including escaped strings and UTF-8 Display Strings. The parser checks the entire field: malformed parameters or extra field members invalidate it rather than enabling compression from a valid prefix. See [RFC 9651 parameter parsing](https://www.rfc-editor.org/rfc/rfc9651.html#section-4.2.3.2).

`dictionaryEncodings` accepts an array or synchronous function `(req) => ['dcb', 'dcz']`. It limits candidates but cannot override the client's capabilities or preferences. An empty array disables dictionary encodings and dictionary advertisements on asset responses. The demo uses it for `?encoding=dcb`, `dcz`, or `auto`; the general server assigns no special meaning to these queries.

The server adds `Vary: Accept-Encoding, Available-Dictionary, Sec-Fetch-Site, Sec-Fetch-Mode`. The Fetch Metadata fields reflect its same-origin policy. CORS is not configured. Incompatible cross-origin requests receive a fallback, or a refusal for dictionary resources.

Encoders are build dependencies only. Older manifests without dcb can still serve dcz and ordinary fallbacks; rebuild to add dcb.

Set `serverTiming: true` on the Node handler to expose handling time through `Server-Timing: asset;dur=...`, alongside the chosen `encoding` and `dictionary` descriptions. It is disabled by default. This measures server processing before headers, not browser decompression. The playground combines it with Resource Timing for its comparison table.

## History and activation

Default asset delivery registers each changed file and prepares variants for three bases per family. A v1 browser can receive v3 using D1 when retained; otherwise it receives an ordinary fallback and can retain v3 as its next base. Separate stable mode can reuse one base across many deployments; changing its epoch rotates that base. See [dictionary policy](dictionary-policy.md).

There is no automatic garbage collection. Retention must account for caches, rollback, and active releases. Never delete an object referenced by a live manifest.

1. Restore the persistent store and serialize builds using it.
2. Build into a fresh release directory.
3. Run all preparation steps and verify the manifest.
4. Deploy the entire directory, including hidden `.cdt` files.
5. Atomically switch the active release reference.
6. Preserve old hashed asset URLs according to the application's needs.

The interactive playground retains routes for all four prebuilt product releases. The generic handler serves one selected directory per request; applications need their own policy to retain older URLs. Serving only `dist/assets` through an ordinary static server does not activate dictionary negotiation. Proxies must preserve the required headers and encoded bodies.

## Scope

The Node server reads files and calculates hashes per request. It buffers responses and has no streaming, LRU cache, Range support, authentication, persistent metrics, or automated cleanup. Range requests receive a complete 200 response. Do not rebuild a demo release directory while serving that same directory; use fresh directories for deployments.

The [adoption guides](adoption.md) cover other serving arrangements. Use this project for public assets controlled by the build, not mixed private and attacker-controlled content. See [RFC 9842 security considerations](https://www.rfc-editor.org/rfc/rfc9842.html#section-9).
