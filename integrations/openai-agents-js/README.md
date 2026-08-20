# @braintrust/openai-agents

[![npm version](https://img.shields.io/npm/v/%40braintrust%2Fopenai-agents.svg)](https://www.npmjs.com/package/@braintrust/openai-agents)

SDK for integrating Braintrust with OpenAI Agents.

> [!WARNING]
> This package is deprecated and will stop being published after the next
> release. Use the OpenAI Agents integration in `braintrust` instead.

## Installation

```bash
npm install braintrust @openai/agents
# or
yarn add braintrust @openai/agents
# or
pnpm add braintrust @openai/agents
```

## Requirements

- `braintrust`
- `@openai/agents`

## Quickstart

```typescript
import { initLogger } from "braintrust";
import { OpenAIAgentsTraceProcessor } from "braintrust/instrumentation";
import { Agent, run, addTraceProcessor } from "@openai/agents";

// Initialize Braintrust logger
const logger = initLogger({
  projectName: "my-agents-project",
});

// Create the tracing processor
const processor = new OpenAIAgentsTraceProcessor({ logger });

// Add the processor to OpenAI Agents
addTraceProcessor(processor);

// Create and run your agent
const agent = new Agent({
  name: "my-agent",
  model: "gpt-4o-mini",
  instructions: "You are a helpful assistant.",
});

const result = await run(agent, "Hello, world!");
```

## API

### `OpenAIAgentsTraceProcessor`

A tracing processor that logs traces from the OpenAI Agents SDK to Braintrust.

#### Constructor

```typescript
new OpenAIAgentsTraceProcessor(options?: OpenAIAgentsTraceProcessorOptions)
```

**Options:**

- `logger?: Logger` - A Braintrust `Span`, `Experiment`, or `Logger` to use for logging. If undefined, the current span, experiment, or logger will be selected exactly as in `startSpan`.
- `maxTraces?: number` - Maximum number of concurrent traces to keep in memory (default: 10000). When exceeded, oldest traces are evicted using LRU policy to prevent memory leaks.

## Documentation

- Braintrust docs: [https://www.braintrust.dev/docs](https://www.braintrust.dev/docs)
- OpenAI Agents docs: [https://openai.github.io/openai-agents-js/](https://openai.github.io/openai-agents-js/)
