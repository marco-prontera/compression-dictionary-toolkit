# References

The protocol and platform APIs come from the references below. Stable epochs, asset preparation, storage layout, and release manifests are project conventions.

| Reference                                                                                                                                                 | Use                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [RFC 9842](https://www.rfc-editor.org/rfc/rfc9842.html)                                                                                                   | Dictionary negotiation, raw bases, dcb/dcz, caching, and security |
| [RFC status](https://datatracker.ietf.org/doc/rfc9842/)                                                                                                   | Standard publication status                                       |
| [Chrome: compression dictionaries](https://developer.chrome.com/blog/search-compression-dictionaries)                                                     | Browser rollout and application context                           |
| [Chromium notes at tag 132](https://chromium.googlesource.com/chromium/src/+/refs/tags/132.0.6833.0/docs/experiments/compression-dictionary-transport.md) | Historical implementation details, not current flag guarantees    |
| [Vite Plugin API](https://vite.dev/guide/api-plugin)                                                                                                      | Build hooks and configuration                                     |
| [Vite guide](https://vite.dev/guide/)                                                                                                                     | Toolchain setup                                                   |
| [Zstandard CLI](https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md)                                                                             | External dictionaries and window limits                           |
| [Brotli CLI](https://github.com/google/brotli/blob/master/c/tools/brotli.md)                                                                              | Dictionary options, quality, and window settings                  |
| [Brotli releases](https://github.com/google/brotli/releases)                                                                                              | Encoder versions                                                  |
| [WICG history](https://github.com/WICG/compression-dictionary-transport)                                                                                  | Evolution from experimental encoding and header names             |
| [mkcert](https://github.com/FiloSottile/mkcert)                                                                                                           | Trusted local HTTPS certificates                                  |
| [Cloudflare shared dictionaries](https://developers.cloudflare.com/speed/optimization/content/shared-dictionaries/)                                       | Passthrough configuration                                         |
| [Cloudflare Vary](https://developers.cloudflare.com/cache/concepts/vary/)                                                                                 | Cache variation and normalization                                 |
| [Cache Rules settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)                                                              | Cache configuration                                               |
| [Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)                                                                    | Original visitor Accept-Encoding                                  |
| [Workers Response API](https://developers.cloudflare.com/workers/runtime-apis/response/)                                                                  | Manual handling of precompressed bytes                            |
| [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)                                                                 | Object storage binding                                            |
| [CloudFront compression](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html)                                  | Automatic compression behavior                                    |
| [CloudFront cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cache-key-understand-cache-policy.html)                    | Object cache keys                                                 |
| [S3 metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html)                                                                   | Object headers and custom metadata                                |
| [CloudFront OAC](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)                        | Private S3 origins                                                |

Current names are `dcb`, `dcz`, `Use-As-Dictionary`, and `Available-Dictionary`. The implementation does not use obsolete `zstd-d`, `br-d`, `Sec-Available-Dictionary`, or `Content-Dictionary` names.

Cloud recipes require verification in the target account and browser. Reading upstream documentation is not a deployment test; see [verification](verification.md).
