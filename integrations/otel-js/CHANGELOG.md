# @braintrust/otel

## 1.0.0

This release promotes `@braintrust/otel` to semver major version 1.0.0. There are no breaking changes in this release.

### Patch Changes

- Updated dependencies: braintrust@3.29.0

## 0.3.0

### Minor Changes

- feat: Add span origin provenance metadata to Braintrust and OpenTelemetry spans (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2226)

### Patch Changes

- Updated dependencies: braintrust@3.24.0

## 0.2.1

### Patch Changes

- fix(otel): Transform v1 spans into v2 compatible format before exporting (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2086)

## 0.2.0

### Minor Changes

- Updated `AISpanProcessor` filtering so root spans are no longer retained by default.
- Added exported helpers for span filtering, including `isRootSpan`, and made custom filtering behavior easier to control.
