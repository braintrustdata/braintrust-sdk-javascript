# @braintrust/browser

## 2.0.0

See the [v4 migration guide](https://github.com/braintrustdata/braintrust-sdk-javascript/blob/main/docs/migration-v3-to-v4.md) for upgrade instructions.

### Major Changes

- build(sdk)!: Migrate to Vite+ and tree-shakeable ESM (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2626)

### Patch Changes

- ref!: Reduce API to a minimum that makes sense (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2429)
- Updated dependencies: braintrust@4.0.0

## 1.0.0

This release promotes `@braintrust/browser` to semver major version 1.0.0. There are no breaking changes in this release.

### Patch Changes

- Updated dependencies: braintrust@3.29.0

## 0.0.2-rc.4

### Patch Changes

- Initial prerelease of the dedicated browser package for Braintrust.
- Added browser-specific configuration to avoid pulling in server-only templating behavior.
- Bundled `als-browser` support to provide AsyncLocalStorage-compatible behavior in browser environments.
