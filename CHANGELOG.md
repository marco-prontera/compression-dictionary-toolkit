# Changelog

## 0.2.0 — Unreleased

This release remains pre-1.0. There are no intended changes to the runtime API, compression formats, or manifest schema compared with 0.1.0.

- Add a standalone consumer project with a registry-pinned dependency, repeatable JS/CSS builds, Node and edge protocol checks, CLI export, TypeScript checks, and real-browser v1→v3 and v1→v4 fallback scenarios.
- Allow `check:packages -- --package compression-dictionary-toolkit@0.1.0` to verify the published archive as well as local source.
- Prepare a publish directory alongside the verified tarball and assert that repacking it produces the same integrity hash.
- Capture npm publication metadata against a loopback-only registry and reject local filesystem paths and `_resolved`/`_from` fields. Publish from the directory to avoid the local tarball path observed in 0.1.0 registry metadata.
- Include these release notes and update the release instructions. npm account identity metadata remains controlled by the registry.

## 0.1.0

Initial public npm release: core dictionary preparation, Vite integration, Node and Web API serving, CLI, and TypeScript declarations in one package. Asset delivery reuses decoded JS/CSS as dictionaries, retains version history, and supports ordinary fallbacks.
