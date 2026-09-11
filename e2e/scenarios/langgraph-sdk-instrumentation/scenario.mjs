import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import * as braintrust from "braintrust";
import {
  runMain,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const packageName = process.env.LANGGRAPH_SDK_PACKAGE;
const { Client } =
  process.env.LANGGRAPH_SDK_MODULE === "cjs"
    ? createRequire(import.meta.url)(packageName)
    : await import(packageName);
const input = {
  messages: [
    { role: "user", content: "Reply with exactly: hello from langgraph" },
  ],
};

runMain(async () => {
  const server = fork(new URL("./server.mjs", import.meta.url), [], {
    execArgv: [],
    env: {
      ...process.env,
      LANGSMITH_TRACING: "false",
      LANGSMITH_TRACING_V2: "false",
      LANGCHAIN_TRACING: "false",
      LANGCHAIN_TRACING_V2: "false",
      LOG_LEVEL: "error",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const exited = once(server, "exit");
  try {
    const { apiUrl } = await Promise.race([
      once(server, "message").then(([message]) => message),
      exited.then(([code]) => {
        throw new Error(`LangGraph server exited before startup: ${code}`);
      }),
    ]);
    const raw = new Client({
      apiUrl,
      apiKey: null,
      callerOptions: { maxRetries: 0 },
    });
    const wrapped = process.env.LANGGRAPH_SDK_MODE !== "auto";
    const client = wrapped ? braintrust.wrapLangGraphSDK(raw) : raw;
    if (wrapped) assert.equal(braintrust.wrapLangGraphSDK(client), client);
    assert.equal(client.threads, raw.threads);
    const options = {
      input,
      metadata: { secret: "DO_NOT_CAPTURE" },
      config: { configurable: { secret: "DO_NOT_CAPTURE" } },
      context: { secret: "DO_NOT_CAPTURE" },
    };
    const expectedUsage = {};
    await runTracedScenario({
      projectNameBase: "tmp-luca-langgraph-sdk-e2e",
      rootName: `LangGraph SDK ${process.env.LANGGRAPH_SDK_VERSION} (${process.env.LANGGRAPH_SDK_MODULE}, ${process.env.LANGGRAPH_SDK_MODE})`,
      metadata: {
        scenario: "langgraph-sdk-instrumentation",
        sdk_version: process.env.LANGGRAPH_SDK_VERSION,
        module: process.env.LANGGRAPH_SDK_MODULE,
        instrumentation_mode: process.env.LANGGRAPH_SDK_MODE,
        expected_error_cases: 4,
      },
      callback: async () => {
        const root = braintrust.currentSpan();
        root.log({
          input: {
            description: "Verify synchronous LangGraph run APIs",
            prompt: input,
          },
        });
        await runOperation(
          "Uninstrumented background APIs",
          "background-apis",
          async () => {
            const background = await client.threads.create();
            const run = await client.runs.create(
              background.thread_id,
              "agent",
              options,
            );
            await client.runs.join(background.thread_id, run.run_id);
            assert.equal(
              (await client.runs.get(background.thread_id, run.run_id)).status,
              "success",
            );
          },
        );

        await runOperation("Wait for final result", "wait", async () => {
          const state = await client.runs.wait(null, "agent", options);
          assert.ok(state.messages.at(-1).content.length > 0);
          expectedUsage.wait = state.messages.at(-1).usage_metadata;
        });

        await runOperation(
          "Interrupt and resume",
          "interrupt-resume",
          async () => {
            const thread = await client.threads.create();
            const interrupted = await client.runs.wait(
              thread.thread_id,
              "approval",
              options,
            );
            assert.equal(
              interrupted.__interrupt__[0].value,
              "Approve the model call?",
            );
            const resumed = await client.runs.wait(
              thread.thread_id,
              "approval",
              { command: { resume: "yes" } },
            );
            assert.ok(resumed.messages.at(-1).content.length > 0);
            expectedUsage.resume = resumed.messages.at(-1).usage_metadata;
          },
        );

        for (const [name, streamMode] of [
          ["values", ["values", "messages", "updates"]],
          ["messages", ["messages"]],
          ["updates", ["updates"]],
          ["stream-error", ["values", "messages"]],
        ]) {
          const operationName =
            name === "stream-error" ? "Stream error" : `Stream ${name} mode`;
          await runOperation(operationName, name, async () => {
            const operationSpan = braintrust.currentSpan();
            const stream = client.runs.stream(
              null,
              name === "stream-error" ? "failing" : "agent",
              {
                ...options,
                streamMode,
                streamSubgraphs: true,
              },
            );
            assert.equal(stream[Symbol.asyncIterator](), stream);
            assert.equal(typeof stream.return, "function");
            const events = [];
            for await (const event of stream) {
              events.push(event);
              assert.equal(braintrust.currentSpan().id, operationSpan.id);
            }
            assert.equal(braintrust.currentSpan().id, operationSpan.id);
            if (name === "stream-error") {
              assert.equal(events.at(-1).event, "error");
            } else {
              const messages = events.flatMap(({ event, data }) => {
                if (event === "values") return data.messages ?? [];
                if (event === "updates")
                  return Object.values(data).flatMap(
                    (update) => update.messages ?? [],
                  );
                if (event === "messages") return [data[0]];
                if (event.startsWith("messages/")) return data;
                return [];
              });
              expectedUsage[name] = messages
                .filter((message) => message.usage_metadata)
                .at(-1).usage_metadata;
              assert.ok(expectedUsage[name].total_tokens > 0);
            }
          });
        }
        await runOperation("Cancel stream", "cancel", async () => {
          const operationSpan = braintrust.currentSpan();
          // Interrupt before generation so disconnect timing cannot leave an
          // in-flight model request in the cassette or affect subsequent runs.
          const cancelled = client.runs.stream(null, "agent", {
            ...options,
            interruptBefore: ["agent"],
            onDisconnect: "cancel",
          });
          assert.equal((await cancelled.next()).value.event, "metadata");
          await cancelled.return();
          assert.equal(braintrust.currentSpan().id, operationSpan.id);
        });

        await runOperation(
          "Missing assistant error",
          "missing-assistant-error",
          () =>
            assert.rejects(
              client.runs.wait(null, "missing-assistant", options),
              /HTTP 404: No assistant found/,
            ),
        );
        await runOperation("Thrown graph error", "thrown-error", () =>
          assert.rejects(
            client.runs.wait(null, "failing", options),
            /Agent failed/,
          ),
        );
        await runOperation(
          "Returned graph error",
          "returned-error",
          async () => {
            assert.ok(
              (
                await client.runs.wait(null, "failing", {
                  ...options,
                  raiseError: false,
                })
              ).__error__,
            );
          },
        );

        await runOperation("Concurrent waits", "concurrent-waits", async () => {
          await Promise.all(
            ["left", "right"].map(async (name) => {
              const state = await client.runs.wait(null, "agent", {
                input: {
                  messages: [
                    { role: "user", content: `Reply with exactly: ${name}` },
                  ],
                },
              });
              const answer = state.messages.at(-1);
              assert.ok(answer.content.includes(name));
              expectedUsage[name] = answer.usage_metadata;
            }),
          );
        });
        root.log({ output: { status: "passed", expected_error_cases: 4 } });
      },
    });
    // Compare logged metrics with the untouched real SDK responses, outside
    // the trace payload so usage is not duplicated in the displayed messages.
    console.log(`LANGGRAPH_EXPECTED_USAGE ${JSON.stringify(expectedUsage)}`);
  } finally {
    if (server.connected) server.disconnect();
    const killTimer = setTimeout(() => server.kill("SIGKILL"), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }
});
