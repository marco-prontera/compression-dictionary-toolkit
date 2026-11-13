# Documentation

New to shared dictionaries? Follow this path:

1. **[Understand the idea](how-it-works.md).** A small JavaScript example, what happens on each visit, and a calculation that includes the dictionary's download cost.
2. **[Watch it happen](local-browser.md).** Build v1, let a browser store its dictionary, and publish v2 while keeping that base.
3. **[Add it to your application](adoption.md).** Connect the build, server, and browser; see what the Vite plugin handles for you.
4. **[Manage later updates](dictionary-policy.md).** Learn when to keep a base, when to replace it, and what happens to visitors holding the old one.

An **asset** is a page's JS or CSS file. A **dictionary** is a saved base used to compress and decode related files. A **manifest** is the JSON index the server uses to find the prepared responses. The guides below build on those three terms.

## Reference guides

Use these when you need a particular option, deployment detail, or verification command. The [playground](../playground/README.md) contains the app, Node server, and edge examples used for local testing.

| Guide                                             | Contents                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| [Adoption](adoption.md)                           | Stable bases, build steps, and choosing a serving adapter           |
| [Dictionary policy](dictionary-policy.md)         | Reuse, rotation, history, and reproducible builds                   |
| [Deployment protocol](deployment-protocol.md)     | Edge manifests, immutable objects, and activation order             |
| [Installation](installation.md)                   | Node, encoders, and environment checks                              |
| [How it works](how-it-works.md)                   | Dictionary bytes, hashes, variants, and release transitions         |
| [Core API](api.md)                                | Functions, options, return values, and CLI                          |
| [Vite](vite.md)                                   | Automatic processing and manual composition                         |
| [Local browser](local-browser.md)                 | v1 → v2, headers, and troubleshooting                               |
| [Server and deployment](server-and-deployment.md) | Negotiation, manifests, history, and rollout                        |
| [Verification](verification.md)                   | Checks, observed results, and limitations                           |
| [References](references.md)                       | Specifications and upstream documentation                           |
| [Releasing](releasing.md)                         | GitHub and npm preparation, ownership checks, and publication order |
