---
"braintrust": minor
---

feat: ship the `bt` CLI with the SDK. Installing `braintrust` now exposes a `bt` command in `node_modules/.bin` that runs the prebuilt native binary for your platform (delivered via `@braintrust/bt-*` optional dependencies). If optional dependencies are skipped (e.g. `--no-optional` / `--omit=optional`), a postinstall script downloads the matching binary from the npm registry as a fallback.
