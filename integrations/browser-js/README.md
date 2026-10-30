# Braintrust Browser SDK

[![npm version](https://img.shields.io/npm/v/%40braintrust%2Fbrowser.svg)](https://www.npmjs.com/package/@braintrust/browser)

Official browser-only SDK for [Braintrust](https://braintrust.dev).

This is an integration package that provides browser-optimized builds of the Braintrust SDK with AsyncLocalStorage polyfill support for standard browsers.

This package supports limited functionality in the browser. There is a known CORS limitation when used outside the `braintrust.dev` domain. If you need this for your own domain, contact [support@braintrust.dev](mailto:support@braintrust.dev).

## Installation

```bash
npm install @braintrust/browser braintrust
# or
pnpm add @braintrust/browser braintrust
# or
yarn add @braintrust/browser braintrust
```

Note: Install both packages so your browser integration and main SDK stay on compatible versions.

## Requirements

- `braintrust` (installed alongside `@braintrust/browser`)
- `zod` (`^3.25.34 || ^4.0`)

## Quickstart

```typescript
import * as braintrust from "@braintrust/browser";

const experiment = await braintrust.init("BrowserExperiment", {
  apiKey: "YOUR_API_KEY",
});

// Use tracing in browser
const result = await braintrust.traced(
  async () => {
    // Your code here
    return "result";
  },
  { name: "myOperation" },
);
```

## Notes

Use `@braintrust/browser` when:

- Building browser-only applications
- Needing AsyncLocalStorage support in standard browsers

Use `braintrust` directly when:

- Building Node.js applications
- Using Next.js or other full-stack frameworks
- Needing CLI tools or filesystem access

Browser-compatible features include:

- Logging and tracing
- Experiments and datasets
- Prompt management
- AI provider wrappers (OpenAI, Anthropic, Google)
- Evaluation framework
- OpenTelemetry integration

## Documentation

For full documentation, visit [https://docs.braintrust.dev](https://docs.braintrust.dev)

## License

Apache-2.0
