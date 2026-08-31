# @braintrust/langchain-js

[![npm version](https://img.shields.io/npm/v/%40braintrust%2Flangchain-js.svg)](https://www.npmjs.com/package/@braintrust/langchain-js)

> [!WARNING]
> This package and all of its exports are deprecated and will stop being
> published after the next release. Use the LangChain integration in
> `braintrust` instead.

## Installation

```bash
npm install braintrust
# or
yarn add braintrust
# or
pnpm add braintrust
```

## Automatic instrumentation

For application-wide instrumentation, use the Braintrust runtime hook:

```bash
node --import braintrust/hook.mjs app.js
```

Braintrust also supports Vite, Webpack, esbuild, and Rollup. See the
[Braintrust SDK documentation](../../js/README.md#auto-instrumentation) for
bundler setup.

## Manual instrumentation

For scoped instrumentation, pass `BraintrustLangChainCallbackHandler` from
`braintrust` through LangChain's `callbacks` option:

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { BraintrustLangChainCallbackHandler } from "braintrust";

const handler = new BraintrustLangChainCallbackHandler();

const model = new ChatOpenAI({
  callbacks: [handler],
});

const response = await model.invoke("Tell me a joke about bears", {
  callbacks: [handler],
});
```

`setGlobalHandler` does not have a direct replacement in `braintrust`. Use
automatic instrumentation for application-wide coverage, or pass the handler
explicitly for scoped instrumentation.

## Documentation

- Braintrust docs: [https://www.braintrust.dev/docs](https://www.braintrust.dev/docs)
- LangChain callback docs: [https://js.langchain.com/docs/how_to/#callbacks](https://js.langchain.com/docs/how_to/#callbacks)
