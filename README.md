# Braintrust JavaScript SDKs

[Braintrust](https://www.braintrust.dev/) is a platform for evaluating and shipping AI products. Learn more at [braintrust.dev](https://www.braintrust.dev/) and in the [docs](https://www.braintrust.dev/docs).

This repository contains Braintrust's JavaScript/TypeScript SDKs and integrations, including:

- The main `braintrust` SDK package (`./js`)
- Integration packages under `./integrations`
- Shared tooling and smoke tests for JavaScript SDK development

## Quickstart

Install the main SDK and autoeval scorers:

```bash
npm install braintrust autoevals
```

Create `tutorial.eval.ts`:

```ts
import { Eval } from "braintrust";
import { LevenshteinScorer } from "autoevals";

Eval("Say Hi Bot", {
  data: () => [
    { input: "Foo", expected: "Hi Foo" },
    { input: "Bar", expected: "Hello Bar" },
  ],
  task: (input) => "Hi " + input,
  scores: [LevenshteinScorer],
});
```

Run it:

```bash
BRAINTRUST_API_KEY=<YOUR_API_KEY> npx braintrust eval tutorial.eval.ts
```

## Packages

| Package                     | Purpose                                                                         | npm                                                                                                                                                          | Docs                                                                               |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `braintrust`                | Core JavaScript/TypeScript SDK for logging, tracing, evals, and CLI.            | [![npm: braintrust](https://img.shields.io/npm/v/braintrust.svg)](https://www.npmjs.com/package/braintrust)                                                  | [js/README.md](js/README.md)                                                       |
| `@braintrust/browser`       | Browser-focused SDK integration with AsyncLocalStorage polyfill support.        | [![npm: @braintrust/browser](https://img.shields.io/npm/v/%40braintrust%2Fbrowser.svg)](https://www.npmjs.com/package/@braintrust/browser)                   | [integrations/browser-js/README.md](integrations/browser-js/README.md)             |
| `@braintrust/langchain-js`  | LangChain.js callback handler integration for automatic Braintrust logging.     | [![npm: @braintrust/langchain-js](https://img.shields.io/npm/v/%40braintrust%2Flangchain-js.svg)](https://www.npmjs.com/package/@braintrust/langchain-js)    | [integrations/langchain-js/README.md](integrations/langchain-js/README.md)         |
| `@braintrust/openai-agents` | OpenAI Agents tracing integration for Braintrust.                               | [![npm: @braintrust/openai-agents](https://img.shields.io/npm/v/%40braintrust%2Fopenai-agents.svg)](https://www.npmjs.com/package/@braintrust/openai-agents) | [integrations/openai-agents-js/README.md](integrations/openai-agents-js/README.md) |
| `@braintrust/otel`          | OpenTelemetry span processor and compatibility helpers for Braintrust tracing.  | [![npm: @braintrust/otel](https://img.shields.io/npm/v/%40braintrust%2Fotel.svg)](https://www.npmjs.com/package/@braintrust/otel)                            | [integrations/otel-js/README.md](integrations/otel-js/README.md)                   |
| `@braintrust/temporal`      | Temporal client/worker plugin and workflow interceptors for Braintrust tracing. | [![npm: @braintrust/temporal](https://img.shields.io/npm/v/%40braintrust%2Ftemporal.svg)](https://www.npmjs.com/package/@braintrust/temporal)                | [integrations/temporal-js/README.md](integrations/temporal-js/README.md)           |

## Documentation

- Publishing packages: [PUBLISHING.md](PUBLISHING.md)
- TypeScript SDK docs: https://www.braintrust.dev/docs/reference/sdks/typescript
- Release notes: https://www.braintrust.dev/docs/reference/release-notes

## License

Apache-2.0

## Repository History

This repository was previously named `braintrust-sdk` and was renamed to `braintrust-sdk-javascript`. The rename happened when Python SDK code was split out of this repository. The Python code now lives in a dedicated [`Braintrust Python SDK`](https://github.com/braintrustdata/braintrust-sdk-python) repository.

## Contributors

Thanks to everyone who contributed to the Braintrust JavaScript SDK!

<a href="https://github.com/braintrustdata/braintrust-sdk-javascript/graphs/contributors">
  <img src="https://contributors-img.web.app/image?repo=braintrustdata/braintrust-sdk-javascript" />
</a>
