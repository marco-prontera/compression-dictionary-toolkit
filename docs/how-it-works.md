# How shared compression dictionaries work

A shared compression dictionary lets a browser reuse bytes it already has when downloading a new file. The **dictionary can be the previous JavaScript or CSS file itself**.

Think of two people with the same reference book. Instead of copying a long passage, the sender can refer to that passage and include the new text. The receiver reconstructs the complete message. Here, the build-time compressor and the browser use exactly the same saved bytes as their reference.

## A small JavaScript example

The first release contains:

```js
// app-v1.js
window.shopLabels = {
    cart: 'Your cart',
    checkout: 'Continue to payment',
    help: 'Contact support',
};
```

The next release changes one label:

```js
// app-v2.js
window.shopLabels = {
    cart: 'Your cart',
    checkout: 'Pay securely',
    help: 'Contact support',
};
```

The browser loads v1 normally. The server marks that response as reusable with `Use-As-Dictionary`. A supporting browser can keep the **decoded v1 bytes** as its dictionary; it needs no separate dictionary download.

Later, the build compresses v2 using those v1 bytes. The browser combines its saved v1 with the compressed response to reconstruct **all of app-v2.js**. The JavaScript engine receives an ordinary, complete program.

This tiny example explains the mechanism; it is not a size benchmark. Compressors work with byte sequences, not JavaScript statements. The response is binary compressed data, not a text patch that your application applies. CSS works the same way.

## What happens on each visit?

Call the saved v1 bytes **D1**. Real dictionaries are identified by their SHA-256 digest, a fingerprint of the complete decoded bytes.

1. **Build v1.** The toolkit saves v1 as a base and prepares ordinary and dictionary-compressed representations. Its manifest records their paths, sizes, and required bases.
2. **First visit.** The browser requests v1 without a dictionary. The server sends ordinary Brotli, gzip, or identity, with `Use-As-Dictionary`. The browser runs v1 and may retain its bytes as D1.
3. **Build v2.** Keep the build store. The toolkit prepares v2 using its retained bases, including D1.
4. **Return for v2.** The browser announces D1 in `Available-Dictionary`. The server may select v2 compressed using D1. The browser reconstructs v2.
5. **Learn the next base.** That response also has `Use-As-Dictionary`. The decoded v2 bytes may become D2 for the next update.

The response in step 4 is **the requested v2 file compressed with D1**. It is not a separate “next dictionary” to download before requesting v2.

The server selects prebuilt files; it does not compress them during a request. It respects accepted encodings and quality preferences, then chooses the smallest equally preferred representation. Ordinary Brotli can win.

## Worked example: the browser has v1, the server already serves v3

Alice opens the site on Monday. She downloads `app-v1.js` normally, and her browser retains it as D1. While she is away, you publish v2 and then v3.

| Moment    | Server release | Alice's browser                           |
| --------- | -------------- | ----------------------------------------- |
| Monday    | v1             | Downloads v1; its decoded bytes become D1 |
| Tuesday   | v2             | Makes no request; still has D1            |
| Wednesday | v3             | Makes no request; still has D1            |
| Thursday  | v3             | Requests app-v3.js and announces D1       |

The default settings are `dictionaryDelivery: 'asset'`, `dictionaryPolicy: 'rolling'`, and `historyLimit: 3`. With three distinct versions, the v3 build prepares v3 against D3, D2, and D1.

```mermaid
sequenceDiagram
    participant B as Alice's browser
    participant S as Server serving v3
    B->>S: GET app-v3.js; Available-Dictionary: hash of D1
    S-->>B: v3 compressed using D1; Use-As-Dictionary for v3
    Note over B: Decode complete v3 using D1; retain v3 as D3
    B->>S: Later request for v4; Available-Dictionary: hash of D3
    S-->>B: v4 compressed using D3
```

Alice needs neither v2 nor a new dictionary beforehand. The diagram assumes dictionary compression wins selection and D1 remains usable in her browser.

### What if the server has already dropped D1?

| Settings for the v3 build             | Prepared bases for v3 | Response to a browser with D1  |
| ------------------------------------- | --------------------- | ------------------------------ |
| Default rolling, history 3            | D3, D2, D1            | May send v3 compressed with D1 |
| Rolling, history 2                    | D3, D2                | Ordinary v3, such as Brotli    |
| Separate stable base, unchanged epoch | D1                    | May send v3 compressed with D1 |

With history 2, the browser still loads v3 immediately. Because the ordinary response also carries `Use-As-Dictionary`, its decoded bytes can become D3. There is no need to fetch D3 separately.

Keeping D1 somewhere on disk is insufficient: **the active manifest needs a v3 representation compressed using D1**. The build creates that representation. The server cannot send a D3-dependent response to a browser that only announced D1.

This example assumes the current HTML requests the v3 URL. An old tab requesting a v1 hashed URL still needs that URL to remain available under your deployment's retention policy.

Try the [v1 → v3 walkthrough](local-browser.md#skip-v2-return-when-the-server-already-serves-v3).

## Cache and URLs matter

A browser may use a dictionary only while it remains eligible under HTTP cache rules and browser storage policy. It can expire or be evicted.

The default asset flow uses `Cache-Control: public, max-age=31536000, immutable`. **Give each changed asset a new URL**, such as `app-<hash>.js` or `app-v3.js`. Keep HTML revalidating so it references the new URLs. Never replace an immutable URL with different bytes.

Use a stable family key and a match pattern covering future filenames, such as `/assets/app-*.js`. The core defaults `match` to the current URL; supply a pattern when filenames change. The Vite plugin derives patterns for standard hashed outputs.

For fixed URLs that must revalidate, the optional [separate dictionary mode](dictionary-policy.md#separate-stable-bases) preserves the previous workflow. Its additional dictionary transfer must be counted separately.

## The headers, in plain language

| Header                 | Direction        | Meaning                                                             |
| ---------------------- | ---------------- | ------------------------------------------------------------------- |
| `Use-As-Dictionary`    | Server → browser | You may retain this decoded response as a dictionary for these URLs |
| `Available-Dictionary` | Browser → server | I have this dictionary fingerprint                                  |
| `Accept-Encoding`      | Browser → server | I accept these compression formats and preferences                  |
| `Content-Encoding`     | Server → browser | This response uses this format                                      |
| `Vary`                 | Server → caches  | These request headers affect the selected response                  |

`br` and `gzip` need ordinary compression support; `dcb` and `dcz` also need the exact announced dictionary. `identity` means uncompressed bytes. The dcb/dcz prefixes include the base digest and add 36/40 bytes, already counted in representation sizes.

These roles follow [RFC 9842](https://www.rfc-editor.org/rfc/rfc9842.html), including response reuse in Section 2.1 and dictionary freshness in Section 2.2. The browser handles registration and decoding; application JavaScript does not set `Available-Dictionary`.

## What is stored where?

| Location                    | Purpose                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `.dictionary-store/`        | Build history; preserve it between builds                                 |
| `dist/assets/app-<hash>.js` | The complete output used by the page                                      |
| `dist/.cdt/dictionaries/`   | Raw bases used to prepare variants and support explicit dictionary routes |
| `dist/.cdt/variants/`       | Prepared identity/br/gzip/dcb/dcz responses                               |
| `dist/.cdt/manifest.json`   | Server index of files and required bases                                  |
| Browser storage             | Its own retained decoded responses                                        |

The presence of `.dict` files in build output does not mean the browser must download them. Default asset responses advertise themselves, without a separate dictionary link. Build history and browser storage are independent: keeping one does not populate the other.

A dictionary is an exact copy of a public final JS/CSS file. It is not a trained word list and is not executed simply because it is used as a dictionary.

## When does this save bytes?

Consider **invented response-body sizes**:

| Transfer        | Ordinary Brotli |             Asset dictionary flow |
| --------------- | --------------: | --------------------------------: |
| First visit, v1 |           30 KB | 30 KB; decoded v1 also becomes D1 |
| Return for v3   |           30 KB |                     5 KB using D1 |
| Total           |           60 KB |                             35 KB |

There is **no additional dictionary download** in this flow. Storage and decoding still have costs; headers are excluded from these numbers. If D1 is unavailable or the dictionary response is larger, an ordinary response remains available.

For a tiny new file, a 36-byte dcb prefix alone may outweigh any saving. The server already compares prepared body sizes, so a separate download-cost heuristic is unnecessary for asset delivery. An estimator for latency or extra decoding time would need representative measurements, rather than assuming that every smaller response is faster.

JavaScript execution happens after reconstruction and receives the same program whichever compression format was used. Execution cost is not an extra dictionary-specific step. Normal caching also comes first: a reusable current response needs no new body transfer.

The demo uses highly similar synthetic files. Measure your own assets and returning visits before predicting savings.
