# Dictionary policy

Two settings answer different questions:

- `dictionaryDelivery`: does the browser learn the base from the requested asset, or fetch a separate dictionary?
- `dictionaryPolicy`: does each changed asset become a base, or does the build keep a stable base until rotation?

Read [how it works](how-it-works.md) for the first visit and the browser-v1/server-v3 example.

## Default: use the assets themselves

```js
sharedDictionary({
    dictionaryDelivery: 'asset',
    dictionaryPolicy: 'rolling',
    historyLimit: 3,
});
```

All three values above are defaults. The browser downloads JS/CSS normally and can retain the decoded response as a base. Each changed asset becomes the newest base for its family.

| Build | Advertised base | Prepared dictionary variants |
| ----- | --------------- | ---------------------------- |
| v1    | D1 = v1 bytes   | v1 using D1                  |
| v2    | D2 = v2 bytes   | v2 using D2 or D1            |
| v3    | D3 = v3 bytes   | v3 using D3, D2, or D1       |
| v4    | D4 = v4 bytes   | v4 using D4, D3, or D2       |

Each entry has both dcb and dcz variants. The limit counts distinct bases, including the current one. Unchanged bytes keep the same digest.

Use URLs that change when bytes change. Asset delivery defaults to `public, max-age=31536000, immutable`; overwriting such a URL can leave visitors running stale code. Vite's normal hashed outputs fit this flow. Custom fixed filenames need a deliberate cache/delivery configuration.

Asset delivery requires rolling bases because the response being advertised must equal the dictionary. Stable policy or a fixed `dictionaryInput` selects separate delivery when delivery is omitted. An explicit combination of asset delivery with stable policy or a fixed input is rejected.

Custom asset cache policies must permit dictionary reuse: positive `max-age`, or a positive `stale-while-revalidate` window without `must-revalidate`. `no-cache`, `no-store`, and policies that leave no usable lifetime are rejected. The stale window can also allow stale asset responses, so versioned URLs remain the recommended setup.

## Families and history

| Setting           | Meaning                                          | Example                                     |
| ----------------- | ------------------------------------------------ | ------------------------------------------- |
| `key`             | Stable name for related versions                 | `app` across releases                       |
| `match`           | URL pattern where the base may be used           | `/assets/app-*.js`                          |
| `historyLimit`    | Number of bases receiving variants in this build | `3` includes current and two previous bases |
| `dictionaryEpoch` | Stable-mode base generation only                 | `base-1` until deliberate rotation          |

The Vite plugin derives families for standard filenames; the core needs your key and match. Keep families specific. If several unrelated outputs share one family, they compete for the same history slots and may compress poorly together.

The default of three bases is a bounded starting point, not a prediction about your visitors. Increase history for visitors who skip more releases, at the cost of more build work and storage. A missing compatible variant causes an ordinary fallback.

## Skipping releases

With D1 in the browser and v3 on the server, history 3 permits v3/D1 directly. History 2 excludes that variant, so the server sends ordinary v3. In either case, the decoded v3 response can become D3 for later requests.

Run the policy comparison:

```sh
node --test --test-name-pattern="a client holding only the v1 dictionary" test/server-base.test.mjs
```

It retains the build store while replacing each release output. The simulated client loads v1, makes no v2 request, and decodes v3 with its saved D1 or an ordinary fallback. Separate stable mode acquires D1 through its dedicated route; asset mode obtains D1 from v1 itself.

The [real-browser test](local-browser.md#automated-browser-test) checks v1→v3 followed by v3→v4, with no `.dict` request or injected capability headers.

## Separate stable bases

Use this opt-in mode for a fixed asset URL that must revalidate, or to keep one deliberately chosen base across many releases:

```js
sharedDictionary({
    dictionaryDelivery: 'separate',
    dictionaryPolicy: 'stable',
    dictionaryEpoch: 'base-1',
    historyLimit: 1,
});
```

Separate delivery defaults to stable policy and `public, max-age=0, must-revalidate` for assets. The server advertises a dedicated dictionary URL with `Link: <...>; rel="compression-dictionary"`. That dictionary response carries `Use-As-Dictionary` and a long freshness lifetime. A visitor can load the ordinary asset before acquiring the separate base.

The base remains D1 across normal updates. A browser holding D1 can decode any prepared newer version directly. This mode has an additional dictionary transfer, so compare that cost with expected savings across subsequent requests. Separate delivery can also be combined explicitly with rolling policy.

## Rotation

In separate stable mode, changing `dictionaryEpoch` selects a new base from the first input of that epoch. `historyLimit: 1` prepares only the new base; old clients fall back. A limit of 2 also prepares responses using the previous base, if retained in the store.

The project does not decide rotation times from traffic. Measure how useful the stable base remains and how often visitors return before replacing it. Never change bytes while retaining their old digest or immutable URL.

## Reproducible builds

Preserve `registry.json` and `dictionaries/` together. Use one build job per shared store/output and separate stores for experimental branches. Toolkit calls in one process queue on shared directories; competing processes fail explicitly with a busy error. See [API concurrency rules](api.md#limits).

A fixed base can be reproduced from an empty store:

```js
await prepareAsset({
    input: './dist/fixed/composed.js',
    outDir: './dist',
    key: 'composed',
    url: '/fixed/composed.js',
    dictionaryDelivery: 'separate',
    dictionaryInput: './compression-bases/composed.js',
    dictionaryEpoch: 'base-1',
});
```

Changing the fixed input within an existing epoch fails. Keeping earlier bases also requires their history. Reproducing an entire rolling release requires its store snapshot, because history determines the prepared variants.

No automatic garbage collection is implemented. Rolling builds add bases as content changes; separate stable updates within an epoch reuse the same base. Keep objects referenced by active releases.

## Older manifests and migration

Existing manifests without `dictionaryDelivery` remain **separate** delivery, including old rolling manifests. They are not reinterpreted as asset dictionaries. Older dcz-only releases remain readable; rebuild to add dcb.

New preparations with no policy/delivery options use asset delivery and rolling history. Update fixed URLs before adopting these defaults, or set `dictionaryDelivery: 'separate'` to preserve the previous stable/revalidating behavior. Explicit `dictionaryPolicy: 'stable'` or `dictionaryInput` also preserves separate delivery.

In asset mode, `asset.dictionaryHash === asset.hash`. With a separate stable base, they may differ. Never infer the delivery mode from the policy or assume every saved base is the current file.
