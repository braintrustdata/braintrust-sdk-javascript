# Writing Plugins for Orchestrion Instrumentation

This guide explains how to write plugins that consume diagnostics channel events from orchestrion instrumentations.

## Table of Contents

- [Overview](#overview)
- [Understanding Orchestrion](#understanding-orchestrion)
- [Diagnostics Channel API](#diagnostics-channel-api)
- [Plugin Architecture](#plugin-architecture)
- [Event Lifecycle](#event-lifecycle)
- [Stream Handling](#stream-handling)
- [Complete Examples](#complete-examples)
- [Best Practices](#best-practices)
- [Testing](#testing)

---

## Overview

### What is Orchestrion?

[Orchestrion](https://github.com/nodejs/orchestrion-js) is a code transformation library that automatically instruments JavaScript/TypeScript code at bundle-time or load-time. It injects calls to Node.js's [diagnostics_channel API](https://nodejs.org/api/diagnostics_channel.html) to enable observability without manual code changes that may be enabled or disabled at any time.

**Key concepts:**

- **FunctionQuery** - Declarative pattern for targeting functions to instrument
- **Transformation** - SWC-based AST modification at compile/load time
- **Diagnostics Channels** - Standard Node.js API for publishing instrumentation events

### How It Works

1. **Configuration** - You specify which functions to instrument via JSON config
2. **Transformation** - Orchestrion modifies code to publish to diagnostics channels
3. **Subscription** - Your plugin subscribes to those channels and handles events

**Example flow:**

```
User calls: client.chat.completions.create(params)
    ↓
Orchestrion publishes: start event
    ↓
Your plugin subscriber receives: { arguments: [params] }
    ↓
Synchronous portion executes (function body runs, returns promise)
    ↓
Orchestrion publishes: end event with the promise
    ↓
User awaits the promise
    ↓
Promise begins to settle
    ↓
Orchestrion publishes: asyncStart event
    ↓
Promise settles with the result
    ↓
Orchestrion publishes: asyncEnd event
    ↓
Your plugin subscriber receives: { result: response }
    ↓
User's await completes, user code continues with result
```

---

## Understanding Orchestrion

### Instrumentation Configuration

Orchestrion uses JSON configs to specify what to instrument:

```json
{
  "channelName": "orchestrion:openai:chat.completions.create",
  "module": {
    "name": "openai",
    "versionRange": ">=4.0.0 <6.0.0",
    "filePath": "resources/chat/completions.mjs"
  },
  "functionQuery": {
    "ClassMethod": {
      "className": "Completions",
      "methodName": "create",
      "kind": "Async"
    }
  }
}
```

### What Orchestrion Generates

For the above config, orchestrion transforms the target function to:

```javascript
// Before transformation
class Completions {
  async create(params) {
    // ... implementation
  }
}

// After orchestrion transformation
class Completions {
  async create(params) {
    const __apm$original_args = arguments;
    const __apm$traced = async () => {
      const __apm$wrapped = async (params) => {
        // ... original implementation
      };
      return __apm$wrapped.apply(null, __apm$original_args);
    };

    if (!tr_ch_apm$create.hasSubscribers) {
      return __apm$traced();
    }

    return tr_ch_apm$create.tracePromise(__apm$traced, {
      arguments,
      self: this,
      moduleVersion: "5.0.0",
    });
  }
}
```

The `tracePromise` function publishes events to the diagnostics channel.

---

## Diagnostics Channel API

### Channel Naming Convention

Orchestrion uses the format: `orchestrion:<module>:<operation>`

Examples:

- `orchestrion:openai:chat.completions.create`
- `orchestrion:anthropic:messages.create`
- `orchestrion:vercel-ai:generateText`

### Event Types

For async functions, orchestrion uses `tracingChannel.tracePromise()` which publishes events at specific points:

#### 1. Start Event

Published when the function is called, before the synchronous portion executes.

```typescript
interface StartEvent {
  // Function arguments (from 'arguments' keyword)
  arguments: ArrayLike<unknown>;

  // The 'this' context
  self?: unknown;

  // Module version (from package.json)
  moduleVersion?: string;
}
```

#### 2. End Event

Published after the synchronous portion completes (when the promise is returned).

```typescript
interface EndEvent {
  // Same context object from start
  arguments: ArrayLike<unknown>;
  self?: unknown;
  moduleVersion?: string;
}
```

#### 3. AsyncStart Event

Published when the promise begins to settle (async continuation starts).

```typescript
interface AsyncStartEvent {
  // Same context object
  arguments: ArrayLike<unknown>;
  self?: unknown;
  moduleVersion?: string;

  // The resolved value (BY REFERENCE - can be mutated!)
  result: unknown;
}
```

#### 4. AsyncEnd Event

Published when the promise finishes settling, **before control returns to user code**.

```typescript
interface AsyncEndEvent {
  // Same context object
  arguments: ArrayLike<unknown>;
  self?: unknown;
  moduleVersion?: string;

  // The resolved value (BY REFERENCE - can be mutated!)
  result: unknown;
}
```

**Important:** The `result` is passed by reference. If it's an object (including streams), you can mutate it **before** the user's code continues.

#### 5. Error Event

Published if the function throws an error or the promise rejects.

```typescript
interface ErrorEvent {
  // Same context object
  arguments: ArrayLike<unknown>;
  self?: unknown;
  moduleVersion?: string;

  // The error that was thrown or rejection reason
  error: Error;
}
```

### Subscribing to Channels

Use the `tracingChannel` API from `dc-browser` (or Node.js `diagnostics_channel`):

```typescript
import { tracingChannel } from "dc-browser";

const channel = tracingChannel("orchestrion:openai:chat.completions.create");

channel.subscribe({
  start: (event) => {
    console.log("Function called with:", event.arguments);
  },

  end: (event) => {
    console.log("Synchronous portion complete, promise returned");
  },

  asyncStart: (event) => {
    console.log("Promise beginning to settle");
  },

  asyncEnd: (event) => {
    console.log("Promise settled with:", event.result);
  },

  error: (event) => {
    console.log("Function threw or promise rejected:", event.error);
  },
});
```

---

## Plugin Architecture

### BasePlugin Class

Extend `BasePlugin` to create a plugin with lifecycle management:

```typescript
import { BasePlugin } from "./core";
import { tracingChannel } from "dc-browser";

export class MyPlugin extends BasePlugin {
  private unsubscribers: Array<() => void> = [];

  protected onEnable(): void {
    // Called when plugin is enabled
    // Subscribe to channels here
    this.subscribeToOpenAI();
  }

  protected onDisable(): void {
    // Called when plugin is disabled
    // Clean up subscriptions
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToOpenAI(): void {
    const channel = tracingChannel(
      "orchestrion:openai:chat.completions.create",
    );

    const handlers = {
      asyncStart: (event) => {
        /* ... */
      },
      asyncEnd: (event) => {
        /* ... */
      },
      error: (event) => {
        /* ... */
      },
    };

    channel.subscribe(handlers);

    // Store unsubscribe function for cleanup
    this.unsubscribers.push(() => {
      channel.unsubscribe(handlers);
    });
  }
}
```

### Plugin Lifecycle

```typescript
const plugin = new MyPlugin();

// Enable the plugin (calls onEnable)
plugin.enable();

// ... plugin is active, handling events ...

// Disable the plugin (calls onDisable)
plugin.disable();
```

---

## Event Lifecycle

### Correlating Events

Each invocation gets a unique context object shared across all events. Your may store your own data on the event object, though it's recommended to use a symbol property so as to not interfere with other consumers. You may also use a `WeakMap` to correlate start/end/asyncStart/asyncEnd/error events, if you prefer to avoid visibility to other consumers:

```typescript
import { tracingChannel } from "dc-browser";

const channel = tracingChannel("orchestrion:openai:chat.completions.create");
const spans = new WeakMap();

channel.subscribe({
  start: (event) => {
    // Create span and store it keyed by context object
    const span = startSpan({ name: "Chat Completion" });
    spans.set(event, span);

    // or:
    // event.span = span;
  },

  // end: (event) => {
  //   // Usually not needed - promise hasn't settled yet
  // },

  // asyncStart: (event) => {
  //   // Usually not needed - just marks promise settlement start
  // },

  asyncEnd: (event) => {
    // Retrieve span using same context object
    const span = spans.get(event);
    // or...
    // const span = event.span;
    if (!span) return;

    span.log({ output: event.result });
    span.end();

    // Clean up (optional for WeakMap, but recommended)
    spans.delete(event);
  },

  error: (event) => {
    const span = spans.get(event);
    // or...
    // const span = event.span;
    if (!span) return;

    span.log({ error: event.error.message });
    span.end();

    // Clean up (optional for WeakMap, but recommended)
    spans.delete(event);
  },
});
```

**Why WeakMap?**

- Automatic garbage collection when context object is no longer referenced
- Does not tie lifetime of span to lifetime of event object
- No memory leaks from forgotten spans
- Fast O(1) lookup

**Common Pattern:**

- Use **start** to create the span and extract input
- Use **asyncEnd** to extract output and finalize the span (this fires before user code continues)
- Use **error** to handle failures

### Extracting Data from Events

#### From start

Extract input data and metadata:

```typescript
start: (event) => {
  const self = event.self; // The `this` in the original call
  const moduleVersion = event.moduleVersion; // The version of the module that triggered the event
  const params = event.arguments[0]; // First argument

  // For OpenAI
  const { messages, model, temperature, ...rest } = params || {};

  span.log({
    input: messages,
    metadata: { model, temperature, ...rest, provider: "openai" },
  });
};
```

#### From asyncEnd

Extract output data and metrics:

```typescript
asyncEnd: (event) => {
  const result = event.result;

  // For OpenAI non-streaming
  span.log({
    output: result.choices,
    metrics: {
      tokens: result.usage?.total_tokens,
      prompt_tokens: result.usage?.prompt_tokens,
      completion_tokens: result.usage?.completion_tokens,
    },
  });
};
```

**Important:** `asyncEnd` fires when the promise settles but **before** user code continues after the await. This is the perfect time to:

- Extract the resolved value
- Patch streams (if the result is an async iterable)
- Finalize the span

---

## Stream Handling

### The Challenge

When a function returns a stream (async iterable), the `asyncEnd` event gives you the stream object, but:

- ❌ You cannot replace the return value
- ❌ You cannot iterate it (would consume it for the user)
- ❌ You cannot clone it (not all streams are cloneable)

### The Solution: Stream Patching

Instead of replacing the stream, **mutate it in-place** by patching its `Symbol.asyncIterator` method.

**Key insight:** `asyncEnd` fires when the promise settles with the stream object, but **before** control returns to user code after the `await`. This gives us a window to patch the stream before the user iterates it.

**Timing for streaming calls:**

```typescript
// User code:
const stream = await client.chat.completions.create({ stream: true });
//               ↑
//               1. start event (function called)
//               2. Synchronous portion executes
//               3. end event (promise returned)
//               4. Promise begins to settle
//               5. asyncStart event
//               6. Promise settles with stream object
//               7. asyncEnd event (WE PATCH HERE!)
//               8. Wrapped promise resolves
//               ← User's await completes, gets patched stream
for await (const chunk of stream) {
  // User iterates, our patched iterator collects chunks
}
```

### Using wrapStreamResult (High-Level API)

The easiest way to handle streaming responses:

```typescript
import { wrapStreamResult } from "./core";

channel.subscribe({
  asyncEnd: (event) => {
    const { span, startTime } = spans.get(event);

    wrapStreamResult(event.result, {
      // Process chunks (for streaming responses)
      processChunks: (chunks) => {
        const output = combineChunks(chunks);
        const metrics = extractMetrics(chunks, startTime);
        return { output, metrics };
      },

      // Process result (for non-streaming responses)
      onNonStream: (result) => {
        const output = result.choices;
        const metrics = extractMetrics(result, startTime);
        return { output, metrics };
      },

      // Called with processed result (both streaming and non-streaming)
      onResult: (processed) => {
        span.log(processed);
        span.end();
        spans.delete(event);
      },

      // Error handling
      onError: (error, chunks) => {
        span.log({
          error: error.message,
          partial_chunks: chunks.length,
        });
        span.end();
        spans.delete(event);
      },
    });
  },
});
```

### Using patchStreamIfNeeded (Low-Level API)

For more control:

```typescript
import { patchStreamIfNeeded, isAsyncIterable } from "./core";

channel.subscribe({
  asyncEnd: (event) => {
    const { span } = spans.get(event);

    if (isAsyncIterable(event.result)) {
      // It's a stream - patch it
      patchStreamIfNeeded(event.result, {
        // Called for each chunk as it's yielded
        onChunk: (chunk) => {
          console.log("Received chunk:", chunk);
        },

        // Called when stream completes
        onComplete: (chunks) => {
          const output = processChunks(chunks);
          span.log({ output, metrics: { chunks: chunks.length } });
          span.end();
        },

        // Called if stream errors
        onError: (error, chunks) => {
          span.log({ error: error.message, partial_chunks: chunks.length });
          span.end();
        },

        // Optional: filter which chunks to collect
        shouldCollect: (chunk) => {
          // Only collect content chunks, skip metadata
          return chunk.type !== "metadata";
        },
      });
    } else {
      // Non-streaming response
      span.log({ output: event.result });
      span.end();
    }

    spans.delete(event);
  },
});
```

### How Stream Patching Works

The helper mutates the stream object by replacing its `Symbol.asyncIterator` method:

```typescript
// Original stream
const stream = event.result;

// Patch the iterator method
const originalIterator = stream[Symbol.asyncIterator];
stream[Symbol.asyncIterator] = function () {
  const iterator = originalIterator.call(this);
  const originalNext = iterator.next.bind(iterator);
  const chunks = [];

  // Wrap the next() method
  iterator.next = async function () {
    const result = await originalNext();

    if (!result.done) {
      chunks.push(result.value); // Collect chunk
    } else {
      // Stream complete - log final output
      span.log({ output: processChunks(chunks) });
      span.end();
    }

    return result; // Pass through to user unchanged
  };

  return iterator;
};

// User's code now uses our patched iterator
for await (const chunk of stream) {
  console.log(chunk); // Works normally
}
```

**Result:** User code is unchanged, but we collect all chunks transparently.

### Edge Cases Handled

The stream patching helpers handle:

1. **Frozen/Sealed Objects** - Detects and warns if stream cannot be patched
2. **Early Cancellation** - Patches `iterator.return()` to handle `break`
3. **Error Injection** - Patches `iterator.throw()` to handle errors
4. **Double-Patching** - Prevents patching the same stream twice

---

## Complete Examples

### Example 1: OpenAI Plugin (Full Implementation)

```typescript
import { BasePlugin } from "./core";
import { tracingChannel } from "dc-browser";
import { startSpan, Span } from "../logger";
import { wrapStreamResult } from "./core";
import { SpanTypeAttribute } from "../../util/index";
import { getCurrentUnixTimestamp } from "../util";

export class OpenAIPlugin extends BasePlugin {
  private unsubscribers: Array<() => void> = [];

  protected onEnable(): void {
    this.subscribeToOpenAI();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToOpenAI(): void {
    // Chat completions
    this.subscribeToChannel("orchestrion:openai:chat.completions.create", {
      name: "Chat Completion",
      type: SpanTypeAttribute.LLM,
      extractInput: (args) => {
        const params = args[0] || {};
        const { messages, ...metadata } = params;
        return {
          input: messages,
          metadata: { ...metadata, provider: "openai" },
        };
      },
      processChunks: (chunks) => {
        const content = chunks
          .map((chunk: any) => chunk.choices?.[0]?.delta?.content || "")
          .filter(Boolean)
          .join("");

        const lastChunk = chunks[chunks.length - 1];
        return {
          output: [{ message: { content } }],
          usage: lastChunk?.usage,
        };
      },
      processNonStream: (result: any) => ({
        output: result.choices,
        usage: result.usage,
      }),
    });

    // Embeddings
    this.subscribeToChannel("orchestrion:openai:embeddings.create", {
      name: "Embedding",
      type: SpanTypeAttribute.LLM,
      extractInput: (args) => {
        const params = args[0] || {};
        const { input, ...metadata } = params;
        return { input, metadata: { ...metadata, provider: "openai" } };
      },
      processChunks: (chunks) => {
        // Embeddings don't stream, but handle just in case
        return { output: chunks, usage: chunks[0]?.usage };
      },
      processNonStream: (result: any) => ({
        output: result.data?.map((d: any) => d.embedding),
        usage: result.usage,
      }),
    });
  }

  private subscribeToChannel(
    channelName: string,
    config: {
      name: string;
      type: string;
      extractInput: (args: any[]) => { input: any; metadata: any };
      processChunks: (chunks: any[]) => { output: any; usage?: any };
      processNonStream: (result: any) => { output: any; usage?: any };
    },
  ): void {
    const channel = tracingChannel(channelName);
    const spans = new WeakMap<any, { span: Span; startTime: number }>();

    const handlers = {
      start: (event: any) => {
        const span = startSpan({
          name: config.name,
          spanAttributes: { type: config.type },
        });

        const startTime = getCurrentUnixTimestamp();
        spans.set(event, { span, startTime });

        try {
          const { input, metadata } = config.extractInput(
            Array.from(event.arguments),
          );
          span.log({ input, metadata });
        } catch (error) {
          console.error(`Error extracting input for ${channelName}:`, error);
        }
      },

      asyncEnd: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) return;

        const { span, startTime } = spanData;

        wrapStreamResult(event.result, {
          processChunks: config.processChunks,
          onNonStream: config.processNonStream,
          onResult: (processed: any) => {
            const metrics: any = {};

            if (processed.usage) {
              metrics.tokens = processed.usage.total_tokens;
              metrics.prompt_tokens = processed.usage.prompt_tokens;
              metrics.completion_tokens = processed.usage.completion_tokens;
            }

            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;

            span.log({ output: processed.output, metrics });
            span.end();
            spans.delete(event);
          },
          onError: (error: Error) => {
            span.log({ error: error.message });
            span.end();
            spans.delete(event);
          },
        });
      },

      error: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) return;

        spanData.span.log({ error: event.error.message });
        spanData.span.end();
        spans.delete(event);
      },
    };

    channel.subscribe(handlers);
    this.unsubscribers.push(() => channel.unsubscribe(handlers));
  }
}
```

### Example 2: Anthropic Plugin

```typescript
import { BasePlugin } from "./core";
import { tracingChannel } from "dc-browser";
import { startSpan } from "../logger";
import { wrapStreamResult } from "./core";
import { SpanTypeAttribute } from "../../util/index";

export class AnthropicPlugin extends BasePlugin {
  private unsubscribers: Array<() => void> = [];

  protected onEnable(): void {
    this.subscribeToAnthropic();
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }

  private subscribeToAnthropic(): void {
    const channel = tracingChannel("orchestrion:anthropic:messages.create");
    const spans = new WeakMap();

    channel.subscribe({
      start: (event: any) => {
        const span = startSpan({
          name: "Anthropic Message",
          spanAttributes: { type: SpanTypeAttribute.LLM },
        });

        const params = event.arguments[0] || {};

        // Coalesce messages and system prompt
        const input = [
          ...(params.system
            ? [{ role: "system", content: params.system }]
            : []),
          ...(params.messages || []),
        ];

        const { messages, system, ...metadata } = params;

        span.log({
          input,
          metadata: { ...metadata, provider: "anthropic" },
        });

        spans.set(event, { span, startTime: Date.now() });
      },

      asyncEnd: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) return;

        const { span, startTime } = spanData;

        wrapStreamResult(event.result, {
          processChunks: (chunks: any[]) => {
            // Extract text from content_block_delta events
            const textChunks = chunks.filter(
              (chunk) =>
                chunk.type === "content_block_delta" &&
                chunk.delta?.type === "text_delta",
            );

            const content = textChunks
              .map((chunk) => chunk.delta.text)
              .join("");

            // Find usage in message_stop event
            const stopEvent = chunks.find((c) => c.type === "message_stop");
            const usage = stopEvent?.message?.usage;

            return {
              output: [{ type: "text", text: content }],
              metrics: {
                input_tokens: usage?.input_tokens,
                output_tokens: usage?.output_tokens,
                chunks: chunks.length,
                time_to_first_token: Date.now() - startTime,
              },
            };
          },

          onNonStream: (result: any) => ({
            output: result.content,
            metrics: {
              input_tokens: result.usage?.input_tokens,
              output_tokens: result.usage?.output_tokens,
              time_to_first_token: Date.now() - startTime,
            },
          }),

          onResult: (processed: any) => {
            span.log(processed);
            span.end();
            spans.delete(event);
          },

          onError: (error: Error) => {
            span.log({ error: error.message });
            span.end();
            spans.delete(event);
          },
        });
      },

      error: (event: any) => {
        const spanData = spans.get(event);
        if (!spanData) return;

        spanData.span.log({ error: event.error.message });
        spanData.span.end();
        spans.delete(event);
      },
    });

    this.unsubscribers.push(() =>
      channel.unsubscribe({
        asyncStart: () => {},
        asyncEnd: () => {},
        error: () => {},
      }),
    );
  }
}
```

### Example 3: Simple Function Instrumentation

For standalone functions (not class methods):

```typescript
// Instrumenting a standalone async function
const channel = tracingChannel("orchestrion:my-lib:fetchData");

channel.subscribe({
  asyncStart: (event: any) => {
    const [url, options] = event.arguments;
    console.log("Fetching:", url, options);
  },

  asyncEnd: (event: any) => {
    console.log("Fetched:", event.result);
  },

  error: (event: any) => {
    console.error("Fetch failed:", event.error);
  },
});
```

---

## Best Practices

### 1. Always Clean Up Subscriptions

```typescript
class MyPlugin extends BasePlugin {
  private unsubscribers: Array<() => void> = [];

  protected onDisable(): void {
    // ALWAYS unsubscribe to prevent memory leaks
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
  }
}
```

### 2. Use WeakMap for Event Correlation

```typescript
// ✅ Good - automatic garbage collection
const spans = new WeakMap();

// ❌ Bad - manual cleanup required, risk of memory leaks
const spans = new Map();
```

### 3. Handle Missing Span Data Gracefully

```typescript
asyncEnd: (event) => {
  const spanData = spans.get(event);
  if (!spanData) {
    // This can happen if asyncStart wasn't called
    // or if the span was already cleaned up
    return;
  }
  // ... rest of handler
};
```

### 4. Wrap Data Extraction in Try-Catch

```typescript
start: (event) => {
  try {
    const { input, metadata } = extractInput(event.arguments);
    span.log({ input, metadata });
  } catch (error) {
    console.error("Error extracting input:", error);
    // Continue - don't let extraction errors break instrumentation
  }
};
```

### 5. Delete Span Data After Use

```typescript
asyncEnd: (event) => {
  const spanData = spans.get(event);
  if (!spanData) return;

  span.log({ output: event.result });
  span.end();

  // ALWAYS delete to prevent memory growth
  spans.delete(event);
};
```

### 6. Check for Stream Support

```typescript
import { isAsyncIterable } from "./core";

asyncEnd: (event) => {
  if (isAsyncIterable(event.result)) {
    // Handle streaming
    patchStreamIfNeeded(event.result, { ... });
  } else {
    // Handle non-streaming
    span.log({ output: event.result });
    span.end();
  }
}
```

### 7. Use Type Guards

```typescript
interface OpenAIResponse {
  choices: any[];
  usage?: {
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
  };
}

function isOpenAIResponse(value: unknown): value is OpenAIResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "choices" in value &&
    Array.isArray(value.choices)
  );
}

asyncEnd: (event) => {
  if (isOpenAIResponse(event.result)) {
    // TypeScript knows event.result is OpenAIResponse
    span.log({ output: event.result.choices });
  }
};
```

---

## Testing

### Unit Testing Event Handlers

```typescript
import { describe, it, expect, vi } from "vitest";
import { tracingChannel } from "dc-browser";

describe("OpenAI Plugin", () => {
  it("logs input on start", () => {
    const channel = tracingChannel(
      "orchestrion:openai:chat.completions.create",
    );
    const logSpy = vi.fn();

    channel.subscribe({
      start: (event) => {
        const params = event.arguments[0];
        logSpy(params.messages);
      },
    });

    // Simulate orchestrion publishing an event
    const mockEvent = {
      arguments: [{ messages: [{ role: "user", content: "Hi" }] }],
      self: {},
      moduleVersion: "5.0.0",
    };

    // Trigger the event
    channel.traceSync(() => {}, mockEvent);

    expect(logSpy).toHaveBeenCalledWith([{ role: "user", content: "Hi" }]);
  });
});
```

### Testing Stream Patching

```typescript
import { patchStreamIfNeeded } from "./core";

describe("Stream patching", () => {
  it("collects chunks from async iterator", async () => {
    async function* mockStream() {
      yield { delta: "Hello" };
      yield { delta: " " };
      yield { delta: "world" };
    }

    const stream = mockStream();
    const collected: any[] = [];

    patchStreamIfNeeded(stream, {
      onComplete: (chunks) => {
        collected.push(...chunks);
      },
    });

    // Consume the stream
    const result: any[] = [];
    for await (const chunk of stream) {
      result.push(chunk);
    }

    // Verify both user gets chunks AND we collected them
    expect(result).toHaveLength(3);
    expect(collected).toHaveLength(3);
    expect(collected[0].delta).toBe("Hello");
  });

  it("handles stream errors", async () => {
    async function* errorStream() {
      yield { data: "chunk1" };
      throw new Error("Stream error");
    }

    const stream = errorStream();
    let errorCaught = false;
    let chunksBeforeError: any[] = [];

    patchStreamIfNeeded(stream, {
      onComplete: () => {},
      onError: (error, chunks) => {
        errorCaught = true;
        chunksBeforeError = chunks;
      },
    });

    await expect(async () => {
      for await (const chunk of stream) {
        // consume
      }
    }).rejects.toThrow("Stream error");

    expect(errorCaught).toBe(true);
    expect(chunksBeforeError).toHaveLength(1);
  });

  it("handles early cancellation", async () => {
    async function* longStream() {
      for (let i = 0; i < 100; i++) {
        yield { i };
      }
    }

    const stream = longStream();
    let onCompleteCalled = false;
    const collected: any[] = [];

    patchStreamIfNeeded(stream, {
      onComplete: (chunks) => {
        onCompleteCalled = true;
        collected.push(...chunks);
      },
    });

    // Consume only 5 chunks then break
    let count = 0;
    for await (const chunk of stream) {
      count++;
      if (count === 5) break;
    }

    // onComplete should still be called with partial chunks
    expect(onCompleteCalled).toBe(true);
    expect(collected).toHaveLength(5);
  });
});
```

### Integration Testing with Real SDKs

```typescript
import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { OpenAIPlugin } from "./openai-plugin";
import { initLogger, currentSpan } from "../logger";

describe("OpenAI Plugin Integration", () => {
  it("logs streaming chat completion", async () => {
    // Set up plugin
    const plugin = new OpenAIPlugin();
    plugin.enable();

    // Initialize logger
    initLogger({ projectName: "test" });

    // Make actual API call
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const stream = await client.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    });

    // Consume stream
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // Verify span was logged
    const span = currentSpan();
    expect(span).toBeDefined();
    // Add more assertions about span data

    plugin.disable();
  });
});
```

---

## Advanced Topics

### Custom Event Context

Add custom context to events:

```typescript
start: (event) => {
  const span = startSpan({ name: "Operation" });

  // Store additional context
  spans.set(event, {
    span,
    startTime: Date.now(),
    requestId: generateRequestId(),
    userId: getCurrentUserId(),
  });
};
```

### Conditional Instrumentation

Only instrument certain calls:

```typescript
start: (event) => {
  const params = event.arguments[0];

  // Skip instrumentation for specific models
  if (params.model === "gpt-3.5-turbo") {
    return; // Don't create span
  }

  const span = startSpan({ name: "Chat Completion" });
  spans.set(event, { span });
};
```

### Multiple Channel Subscription

Subscribe to multiple channels with shared logic:

```typescript
class MultiProviderPlugin extends BasePlugin {
  protected onEnable(): void {
    const providers = [
      { channel: "orchestrion:openai:chat.completions.create", name: "OpenAI" },
      { channel: "orchestrion:anthropic:messages.create", name: "Anthropic" },
      { channel: "orchestrion:vercel-ai:generateText", name: "Vercel" },
    ];

    for (const { channel, name } of providers) {
      this.subscribeToProvider(channel, name);
    }
  }

  private subscribeToProvider(channelName: string, providerName: string): void {
    const channel = tracingChannel(channelName);
    // ... shared subscription logic
  }
}
```

---

## Troubleshooting

### Events Not Firing

**Problem:** Your subscriber isn't being called.

**Solutions:**

1. Verify orchestrion config is correct
2. Check channel name matches exactly
3. Ensure orchestrion transformation is running (check bundler plugin)
4. Verify function is actually being called
5. Check if `hasSubscribers` optimization is preventing instrumentation

```typescript
// Debug: Force channel to always instrument
const channel = tracingChannel("orchestrion:openai:chat.completions.create");
channel.hasSubscribers = true; // Force instrumentation
```

### Stream Not Being Patched

**Problem:** Streaming output not collected.

**Solutions:**

1. Verify `event.result` is actually an async iterable
2. Check if stream is frozen/sealed
3. Ensure patching happens in `asyncEnd`, not `asyncStart`
4. Check browser console for warnings

```typescript
import { isAsyncIterable } from "./core";

asyncEnd: (event) => {
  console.log("Is stream?", isAsyncIterable(event.result));
  console.log("Is frozen?", Object.isFrozen(event.result));
};
```

### Memory Leaks

**Problem:** Memory usage growing over time.

**Solutions:**

1. Always delete from WeakMap after span ends
2. Unsubscribe channels in `onDisable`
3. Use WeakMap, not Map
4. Check for dangling references

```typescript
// ✅ Good
asyncEnd: (event) => {
  span.end();
  spans.delete(event); // Always delete
};

// ❌ Bad
asyncEnd: (event) => {
  span.end();
  // Forgot to delete - memory leak!
};
```

---

## Summary

**Key Takeaways:**

1. **Orchestrion** instruments code at build/load time to publish diagnostics channel events
2. **Diagnostics Channels** provide asyncStart/asyncEnd/error events for instrumented functions
3. **BasePlugin** provides lifecycle management for subscribing to channels
4. **WeakMap** correlates events across asyncStart/asyncEnd/error
5. **Stream Patching** enables collecting streaming outputs by mutating the stream in-place
6. **wrapStreamResult** provides high-level API for handling both streaming and non-streaming results

**Next Steps:**

- Review the `BraintrustPlugin` implementation for a complete example
- Read `core/stream-patcher.ts` for stream patching implementation details
- Check orchestrion documentation for creating instrumentation configs
- Write tests for your plugin before deploying

---

## Additional Resources

- [Orchestrion Documentation](https://github.com/nodejs/orchestrion-js)
- [Node.js Diagnostics Channel API](https://nodejs.org/api/diagnostics_channel.html)
- [BraintrustPlugin Implementation](./braintrust-plugin.ts)
- [Stream Patcher Source](./core/stream-patcher.ts)
