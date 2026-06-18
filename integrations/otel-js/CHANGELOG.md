# @braintrust/otel

## 0.2.1

### Patch Changes

- fix(otel): Transform v1 spans into v2 compatible format before exporting (https://github.com/braintrustdata/braintrust-sdk-javascript/pull/2086)

## 0.2.0

### Minor Changes

- Updated `AISpanProcessor` filtering so root spans are no longer retained by default.
- Added exported helpers for span filtering, including `isRootSpan`, and made custom filtering behavior easier to control.
