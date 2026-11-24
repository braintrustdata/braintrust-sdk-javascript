// Focused framework regressions with controlled plugin output/failure injection.
// These do not replace the real-provider cassette scenarios.
import "./configure.mjs";
import assert from "node:assert/strict";
import { initLogger, wrapLiveKit, wrapOpenAI } from "braintrust";
import { scopedName } from "../../helpers/provider-runtime.mjs";
const agents = await import("@livekit/agents");
const {
  voice,
  llm,
  initializeLogger,
  APIConnectionError,
  DEFAULT_API_CONNECT_OPTIONS,
} = process.env.LIVEKIT_WRAP === "1" ? wrapLiveKit(agents) : agents;
initializeLogger({ pretty: false, level: "silent" });
const logger = initLogger({ projectName: scopedName("e2e-livekit-framework") });
if (process.env.LIVEKIT_PROBE === "ownership") {
  const original = await import("@livekit/agents-plugin-openai");
  const plugin =
    process.env.LIVEKIT_WRAP === "1" ? wrapLiveKit(original) : original;
  const { default: OpenAI } = await import("openai");
  const failure = new Error("controlled client transport failure");
  const sdk = new OpenAI({
    apiKey: "probe",
    maxRetries: 0,
    fetch: async () => {
      throw failure;
    },
  });
  const client =
    process.env.LIVEKIT_PROBE_CLIENT === "sdk"
      ? process.env.LIVEKIT_WRAP === "1"
        ? wrapOpenAI(sdk)
        : sdk
      : {
          chat: {
            completions: {
              create() {
                throw failure;
              },
            },
          },
          audio: {
            transcriptions: {
              create() {
                throw failure;
              },
            },
            speech: {
              create() {
                throw failure;
              },
            },
          },
        };
  const services = {
    llm: new plugin.LLM({ apiKey: "probe", client }),
    stt: new plugin.STT({ apiKey: "probe", useRealtime: false, client }),
    tts: new plugin.TTS({ apiKey: "probe", client }),
  };
  const session = new voice.AgentSession(services);
  session.on("error", () => {});
  await session.start({
    agent: new voice.Agent({ instructions: "Ownership regression" }),
    record: false,
  });
  const { AudioFrame } = await import("@livekit/rtc-node");
  await assert.rejects(
    services.stt.recognize(new AudioFrame(new Int16Array(480), 24000, 1, 480)),
  );
  // These native task boundaries stand in for node execution in this focused
  // adapter test. All adapter/client classes and invocation hooks are real.
  await agents.telemetry.tracer.startActiveSpan(
    async () => {
      try {
        const stream = services.tts.synthesize("actual synthesis text");
        for await (const _ of stream) {
          /* consume */
        }
      } catch (error) {
        assert(error);
      }
    },
    { name: "tts_node", context: session.rootSpanContext },
  );
  await agents.telemetry.tracer.startActiveSpan(
    async () => {
      const stream = services.llm.chat({
        chatCtx: new llm.ChatContext(),
        connOptions: { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 },
      });
      try {
        for await (const _ of stream) {
          /* consume */
        }
      } catch (error) {
        assert(error);
      }
    },
    { name: "llm_node", context: session.rootSpanContext },
  );
  await session.close();
  await logger.flush();
  process.exit(0);
}
let attempts = 0;
let created = 0;
let unblock;
const produced = new Promise((resolve) => {
  unblock = resolve;
});
class RetryStream extends llm.LLMStream {
  async run() {
    const attempt = ++attempts;
    this.queue.put({
      id: `attempt-${attempt}`,
      delta: { role: "assistant", content: attempt === 1 ? "FIRST" : "SECOND" },
    });
    this.queue.put({
      id: `attempt-${attempt}`,
      usage: {
        promptTokens: attempt * 3,
        completionTokens: 2,
        totalTokens: attempt * 3 + 2,
        promptCachedTokens: attempt,
        cacheCreationTokens: 0,
        reasoningTokens: 1,
        serviceTier: attempt === 1 ? "flex" : "priority",
      },
    });
    if (attempt === 1)
      throw new APIConnectionError({ message: "controlled retry" });
    unblock();
  }
  async next() {
    // Deliberately let BOTH attempts finish before reading the shared output.
    await produced;
    return super.next();
  }
}
class RetryLLM extends llm.LLM {
  label() {
    return "controlled-retry";
  }
  get model() {
    return "controlled-model";
  }
  chat(params) {
    created++;
    return new RetryStream(this, {
      ...params,
      connOptions: {
        ...DEFAULT_API_CONNECT_OPTIONS,
        maxRetry: 1,
        retryIntervalMs: 0,
      },
    });
  }
}
const session = new voice.AgentSession({ llm: new RetryLLM() });
session.on("error", () => {});
const committed = [];
session.on("conversation_item_added", (event) => committed.push(event.item));
await session.start({
  agent: new voice.Agent({ instructions: "Framework regression" }),
  record: false,
});
let deadline;
try {
  // Bound this controlled-failure probe, including a stalled retry worker.
  await Promise.race([
    session.generateReply({ userInput: "go" }).waitForPlayout(),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () =>
          reject(
            new Error(
              `retry probe timed out (${created} streams, ${attempts} attempts)`,
            ),
          ),
        10000,
      );
    }),
  ]);
} finally {
  clearTimeout(deadline);
}
assert.equal(attempts, 2);
assert.equal(
  committed.find((item) => item.role === "assistant")?.textContent,
  "FIRSTSECOND",
);
await session.close();
await logger.flush();
process.exit(0);
