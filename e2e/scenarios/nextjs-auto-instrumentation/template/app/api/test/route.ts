import "braintrust"; // Registers Braintrust's global instrumentation hooks.
import OpenAI from "openai";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Must be dynamic — this route starts an in-process HTTP server per request.
export const dynamic = "force-dynamic";

type InstrumentationHook = {
  subscribe(handlers: InstrumentationHookHandlers): void;
  unsubscribe(handlers: InstrumentationHookHandlers): boolean;
};

type InstrumentationHookHandlers = {
  start(): void;
};

export async function GET() {
  // Spin up a minimal mock OpenAI server so no real API calls are made.
  const mockServer = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
  });

  await new Promise<void>((resolve) =>
    mockServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = mockServer.address() as AddressInfo;

  const hooks = (
    globalThis as typeof globalThis & {
      __braintrust_instrumentation_hooks?: Map<string, InstrumentationHook>;
    }
  ).__braintrust_instrumentation_hooks;
  const hook = hooks?.get("orchestrion:openai:chat.completions.create");
  let hookFired = false;
  const subscriber = {
    start: () => {
      hookFired = true;
    },
  };

  hook?.subscribe(subscriber);

  try {
    const client = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test",
      maxRetries: 0,
    });
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
  } finally {
    hook?.unsubscribe(subscriber);
    mockServer.close();
  }

  return Response.json({ instrumented: hookFired });
}
