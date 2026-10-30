# Temporal + AI SDK + Braintrust Example

This example demonstrates how to integrate the [Vercel AI SDK](https://sdk.vercel.ai/) with [Temporal](https://temporal.io/) workflows while using [Braintrust](https://braintrust.dev/) to trace both Temporal workflows and LLM calls.

## Integration Pattern

### Custom Activities with wrapAISDK

This example uses custom activities with Braintrust's `wrapAISDK` for comprehensive instrumentation. This provides detailed tracing including LLM calls, tool calls, and streaming.

**Example:** [`haikuAgent`](src/workflows.ts) + [`generateTextTraced`](src/activities.ts#L18-L35)

**Activity:**

```typescript
import { wrapAISDK } from "braintrust";
import * as ai from "ai";
import { openai } from "@ai-sdk/openai";

const wrappedAI = wrapAISDK(ai);

export async function generateTextTraced(params: {
  modelId: string;
  prompt: string;
  system?: string;
}): Promise<string> {
  const result = await wrappedAI.generateText({
    model: openai(params.modelId),
    system: params.system,
    prompt: params.prompt,
  });
  return result.text;
}
```

**Workflow:**

```typescript
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";

const { generateTextTraced } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
});

export async function haikuAgent(topic: string): Promise<string> {
  return await generateTextTraced({
    modelId: "gpt-4o-mini",
    system: "You only respond in haikus",
    prompt: `Write a haiku about ${topic}`,
  });
}
```

**Trace hierarchy:**

```
temporal.workflow.haikuAgent
  └── temporal.activity.generateTextTraced
      └── generateText
          └── doGenerate
              ├── input: { prompt: "...", system: "..." }
              ├── output: { text: "...", finishReason: "stop" }
              ├── metrics: { promptTokens: 15, completionTokens: 20 }
              └── toolCalls: [...]  ← When using tools
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm
- Temporal CLI (install with `brew install temporal` or `mise install`)
- OpenAI API key
- Braintrust API key

### Setup

1. **Copy environment variables:**

```bash
cp .env.example .env
```

2. **Edit `.env` and add your API keys:**

```bash
BRAINTRUST_API_KEY=your-braintrust-api-key
OPENAI_API_KEY=your-openai-api-key
```

3. **Install dependencies:**

```bash
pnpm install
```

4. **Build the Braintrust Temporal integration:**

```bash
pnpm run build:integration
```

### Running Examples

The easiest way to run this example is using **mise** (recommended):

#### Using Mise (Recommended)

**Terminal 1: Start Server + Worker**

```bash
mise run server
```

This starts both the Temporal server and worker with Braintrust tracing enabled.

**Terminal 2: Run Workflows**

```bash
mise run workflow-haiku    # Text generation with full LLM tracing
mise run workflow-tools    # Function calling with full LLM + tool tracing
```

**Stop Everything:**

```bash
mise run stop    # Graceful shutdown
mise run kill    # Force kill all processes
```

#### Using pnpm Directly (Alternative)

If you prefer to run commands manually:

**Terminal 1: Start Temporal Server**

```bash
temporal server start-dev
```

**Terminal 2: Start the Worker**

```bash
pnpm run worker
```

The worker will connect to Temporal and initialize Braintrust tracing.

**Terminal 3: Run Workflows**

```bash
pnpm run workflow:haiku
pnpm run workflow:tools
```

## Architecture

This example uses a simple pattern:

1. **Workflows** define the business logic and call activities
2. **Activities** perform the actual LLM calls using `wrapAISDK`
3. **Braintrust** traces both Temporal spans and LLM calls automatically

Because AI calls happen in activities (not workflows), no special polyfills are needed in the workflow sandbox.

## Learn More

- [Temporal Documentation](https://docs.temporal.io/)
- [Vercel AI SDK Documentation](https://sdk.vercel.ai/)
- [Braintrust Documentation](https://docs.braintrust.dev)
- [Temporal AI SDK Integration](https://github.com/temporalio/samples-typescript/tree/main/ai-sdk)
- [Braintrust Temporal Integration](https://docs.braintrust.dev/integrations/sdk-integrations/temporal)

---

## Example Workflows

| Workflow     | File                             | Description                             |
| ------------ | -------------------------------- | --------------------------------------- |
| `haikuAgent` | [workflows.ts](src/workflows.ts) | Text generation with full LLM tracing   |
| `toolsAgent` | [workflows.ts](src/workflows.ts) | Function calling with full tool tracing |
