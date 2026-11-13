# Releasing

The repository root is the single public npm package **`compression-dictionary-toolkit`**, with published version **0.1.0** and prepared candidate **0.2.0**. Its entry points are the core (`.`), `/vite`, `/server`, and `/edge`; it also supplies the `shared-dict` CLI.

There are no workspace packages or internal npm dependencies to publish separately. Vite 7/8 is an optional peer dependency. Source modules and declarations remain separate under `src/`; only `src/`, package metadata, the README, changelog, and the MIT license belong in the tarball. Playground code, tests, local deployment guides, generated assets, and release tooling stay outside it.

## Validate the release

Use Node 24 for development, install the encoders described in [installation](installation.md), and run:

```sh
npm ci
npm run lint
npm run format:check
npm run doctor
npm test
npm run check:types
npm run check:packages
npm run demo:cycle
npm run demo:export
npx playwright install chromium
npm run test:browser
```

Stop the demo server before rebuilding its release directories. The GitHub Actions workflow runs these checks on Node 22 and 24, with browser verification on Node 24. Local success does not establish that remote CI has run; see [verification](verification.md).

`check:packages` packs the root, checks the file inventory, and installs the tarball into a temporary project offline with normal peer resolution. It checks that Vite is absent, exercises all four entry points and the CLI, verifies that the Node server does not load build modules, and checks edge imports and declarations without Node dependencies. Vite builds are covered by the integration tests. The same check captures an npm publication request against a temporary loopback-only registry and rejects local paths in its metadata; it does not publish to npm.

To verify an existing registry release:

```sh
npm run check:packages -- --package compression-dictionary-toolkit@0.1.0
```

The [standalone consumer](../examples/package-consumer/README.md) retains the published-package tests and versioned reports. Run its Node/edge/CLI/type and browser checks against both the published baseline and the candidate tarball.

## Create the archive

From the repository root:

```sh
npm run pack:release
```

The command runs the same package checks and, only after they pass, saves:

```text
artifacts/npm/
  compression-dictionary-toolkit-0.2.0.tgz
  package/          verified contents, ready for directory publication
  packages.json
```

The `package/` directory contains the same files as the tarball; repacking it must produce the same integrity hash. Older versioned archives may remain for comparison.

`packages.json` contains npm's inventory, compressed/unpacked sizes, and integrity hashes for the single archive. This directory is ignored by Git. No npm login is required to create the archive, and the command does not publish it.

The source is ESM JavaScript with TypeScript declarations, so there is no transpilation step. Brotli/Zstandard executables are not bundled. Build consumers install them separately; serving prepared files does not need them.

After changing source, declarations, metadata, README files, or the version, rerun the checks and regenerate the archive.

## Check the npm account and name

Version 0.1.0 has been published and verified from the registry. Check your account and the current registry version before publishing 0.2.0:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view compression-dictionary-toolkit name version maintainers --registry=https://registry.npmjs.org/
```

A registry 404 means the name has no package at that moment. Network and authentication failures do not establish availability. If the package exists, verify ownership and that the intended version has not already been published.

Direct publication requires account 2FA or a granular access token with bypass 2FA enabled. Handle authentication through npm and keep credentials out of the repository. See [npm's publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/).

## Publish the verified archive

From the repository root:

```sh
npm publish ./artifacts/npm/package --access public --registry=https://registry.npmjs.org/
```

This publishes from the prepared directory, whose archive is verified against the tested tarball. With npm 11.9.0, publishing a local `.tgz` submitted an absolute `_resolved` path in the public metadata for 0.1.0. Directory publication is checked locally to avoid that field. npm can still expose the publishing account name/email; removing fields from package.json does not anonymize registry account metadata. There is one publication and no dependency ordering. The included CI workflow does not publish automatically on push or tag.

If publication fails, inspect registry state before retrying. A published version cannot be overwritten. After publication, test installation in a fresh project:

```sh
npm install compression-dictionary-toolkit@0.2.0
```

For a Vite application, install Vite separately and import the plugin from `compression-dictionary-toolkit/vite`. A server-only consumer should not receive Vite.

Version 0.2.0 is prepared locally only. Do not mark it as published in the changelog until publication succeeds. Keep releases in the 0.x series until an explicit decision to ship 1.0.0.

## Subsequent releases and GitHub

Update the root version and lockfile together with `npm version patch --no-git-tag-version` (or the appropriate minor/major increment). Rerun verification and `pack:release`, then publish the generated versioned archive. There are no workspace versions to synchronize.

The intended source repository is `https://github.com/marco-prontera/compression-dictionary-toolkit`. Review source changes and generated-file exclusions before committing or pushing. Git initialization, pushing source, npm publication, and creating release tags are separate actions; package preparation performs none of them. Create a release tag only for the verified source commit, with notes describing behavior and known limits.
