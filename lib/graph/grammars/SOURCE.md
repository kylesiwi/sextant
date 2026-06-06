# Vendored tree-sitter grammars

This directory ships pre-built tree-sitter language `.wasm` blobs that
`lib/graph/parser.mjs` loads at runtime. Vendoring keeps the plugin runnable
without a post-install build step.

## Layout

| File              | Language   | Source npm package           | Version | Path inside package                |
| ----------------- | ---------- | ---------------------------- | ------- | ---------------------------------- |
| `typescript.wasm` | TypeScript | `tree-sitter-typescript`     | 0.23.2  | `tree-sitter-typescript.wasm`      |
| `javascript.wasm` | JavaScript | `tree-sitter-javascript`     | 0.25.0  | `tree-sitter-javascript.wasm`      |
| `python.wasm`     | Python     | `tree-sitter-python`         | 0.25.0  | `tree-sitter-python.wasm`          |
| `go.wasm`         | Go         | `tree-sitter-go`             | 0.25.0  | `tree-sitter-go.wasm`              |
| `rust.wasm`       | Rust       | `tree-sitter-rust`           | 0.24.0  | `tree-sitter-rust.wasm`            |

## Integrity

| File              | Bytes     | SHA-256                                                            |
| ----------------- | --------- | ------------------------------------------------------------------ |
| `typescript.wasm` | 1,413,849 | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `javascript.wasm` |   411,770 | `5fb488d0cabb4775a594bab85682de5ad6ce83c0d6ac997a9f82dd084d571240` |
| `python.wasm`     |   457,883 | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `go.wasm`         |   217,182 | `9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7` |
| `rust.wasm`       | 1,102,547 | `f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57` |

Recompute with:

```sh
shasum -a 256 lib/graph/grammars/typescript.wasm
shasum -a 256 lib/graph/grammars/javascript.wasm
shasum -a 256 lib/graph/grammars/python.wasm
shasum -a 256 lib/graph/grammars/go.wasm
shasum -a 256 lib/graph/grammars/rust.wasm
```

## Refresh procedure

When a grammar version bumps:

1. `npm install tree-sitter-typescript@<new-version>` (or the javascript / python / go / rust equivalent).
2. `cp node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm lib/graph/grammars/typescript.wasm`
   (or the javascript / python / go / rust equivalent).
3. Recompute SHA-256 above and update this file (version, bytes, hash).
4. Run `node verify.mjs` and `node --test test/`.

## License

The vendored grammar binaries are MIT-licensed; see the upstream package
LICENSE files in `node_modules/tree-sitter-typescript/LICENSE`,
`node_modules/tree-sitter-javascript/LICENSE`,
`node_modules/tree-sitter-python/LICENSE`,
`node_modules/tree-sitter-go/LICENSE`, and
`node_modules/tree-sitter-rust/LICENSE`. We redistribute them per that
license. We do not modify the binaries.
