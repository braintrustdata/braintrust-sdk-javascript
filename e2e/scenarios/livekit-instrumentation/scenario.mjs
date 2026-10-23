import "./configure.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { initLogger, setFetch, wrapLiveKit } from "braintrust";
import { scopedName } from "../../helpers/provider-runtime.mjs";
import { AudioFrame, dispose } from "@livekit/rtc-node";
const livekit = await import("@livekit/agents");
const { voice, llm, telemetry, initializeLogger } =
  process.env.LIVEKIT_WRAP === "1" ? wrapLiveKit(livekit) : livekit;
initializeLogger({ pretty: false, level: "silent" });
const recording = process.env.BRAINTRUST_CAPTURE_ATTACHMENTS === "true";
let provider;
if (process.env.LIVEKIT_OTEL === "unsampled") {
  // An application provider that samples everything out must stay installed.
  const { NodeTracerProvider, AlwaysOffSampler } =
    await import("@opentelemetry/sdk-trace-node");
  provider = new NodeTracerProvider({ sampler: new AlwaysOffSampler() });
  provider.register();
  telemetry.setTracerProvider(provider);
}
const completedUploads = [];
if (process.env.LIVEKIT_SEGMENTS === "1") {
  setFetch(async (input, init) => {
    const response = await fetch(input, init);
    if (
      new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      ).pathname === "/attachment/status" &&
      response.ok
    ) {
      const body = JSON.parse(init.body);
      if (body.status?.upload_status === "done")
        completedUploads.push({
          key: body.key,
          playedSamples: output.playedSamples,
        });
    }
    return response;
  });
}
const logger = initLogger({ projectName: scopedName("e2e-livekit") });
const providerMode = process.env.LIVEKIT_PROVIDER === "1";
class Output extends voice.AudioOutput {
  samples = 0;
  playedSamples = 0;
  interrupted = false;
  didInterrupt = false;
  startedAt = 0;
  constructor() {
    super(24000);
  }
  async captureFrame(frame) {
    await super.captureFrame(frame);
    if (!this.samples) {
      this.interrupted = false;
      if (process.env.LIVEKIT_PLAYBACK_START_DELAY_MS)
        await sleep(Number(process.env.LIVEKIT_PLAYBACK_START_DELAY_MS));
      this.startedAt = Date.now();
      this.onPlaybackStarted(this.startedAt);
    }
    const duration = (frame.samplesPerChannel / frame.sampleRate) * 1000;
    await sleep(duration);
    this.samples += frame.samplesPerChannel;
    this.playedSamples += frame.samplesPerChannel;
    if (process.env.LIVEKIT_SEGMENTS === "1")
      this.onPlaybackProgressed({
        startedAt: this.startedAt + this.samples / 24 - duration,
        offset: this.samples / 24 - duration,
        duration,
      });
    if (
      process.env.LIVEKIT_INTERRUPT === "1" &&
      this.samples >= 4800 &&
      !this.didInterrupt
    ) {
      this.didInterrupt = true;
      this.clearBuffer();
      void session.interrupt({ force: true }).await;
    }
  }
  flush() {
    super.flush();
    if (!this.interrupted && process.env.LIVEKIT_SEGMENTS !== "1")
      this.onPlaybackProgressed({
        startedAt: this.startedAt,
        offset: 0,
        duration: this.samples / 24,
      });
    if (this.pendingPlayoutSegments > 0)
      this.onPlaybackFinished({
        playbackPosition: this.samples / 24000,
        interrupted: this.interrupted,
      });
    this.samples = 0;
  }
  clearBuffer() {
    this.onPlaybackProgressed({
      startedAt: this.startedAt,
      offset: 0,
      duration: this.samples / 24,
    });
    this.interrupted = true;
    if (this.pendingPlayoutSegments > 0)
      this.onPlaybackFinished({
        playbackPosition: this.samples / 24000,
        interrupted: true,
      });
    this.abandonOpenSegment();
  }
}
const options = {};
const streamingStt = process.env.LIVEKIT_STREAMING_STT === "1";
let ws;
if (providerMode) {
  const { LLM, TTS } = await import("@livekit/agents-plugin-openai");
  options.llm = new LLM({
    model: "gpt-4.1-nano",
    temperature: 0,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  options.tts = new TTS({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    baseURL: process.env.OPENAI_BASE_URL,
  });
}
if (streamingStt) {
  const { websocketCassette } = await import("./websocket-cassette.mjs");
  ws = await websocketCassette(
    process.env.LIVEKIT_WS_PATH,
    process.env.BRAINTRUST_E2E_CASSETTE_MODE === "record",
  );
  const { STT } = await import("@livekit/agents-plugin-openai");
  options.stt = new STT({
    model: "gpt-4o-mini-transcribe",
    useRealtime: true,
    baseURL: ws.baseURL,
  });
  options.turnDetection = "manual";
}
const session = new voice.AgentSession(options);
let inputController;
if (streamingStt) {
  class Input extends voice.AudioInput {
    source = new ReadableStream({
      start(controller) {
        inputController = controller;
      },
    });
    get stream() {
      return this.source;
    }
    async close() {
      try {
        inputController.close();
      } catch {}
    }
  }
  session.input.audio = new Input();
}
const output = new Output();
const committed = [];
let callerTranscript = "";
session.on("user_input_transcribed", (ev) => {
  if (ev.isFinal) callerTranscript += ev.transcript;
});
session.on("conversation_item_added", (ev) => committed.push(ev.item));
session.output.audio = output;
const original = output.captureFrame;
try {
  await session.start({
    agent: new voice.Agent({
      instructions: providerMode
        ? "You help customers check orders. Always call lookup_order when an order number is supplied. Answer with one short sentence giving the delivery day."
        : "Fixture playback",
      tools: providerMode
        ? {
            lookup_order: llm.tool({
              description: "Look up an order delivery status.",
              parameters: z.object({
                order_id: z.string(),
              }),
              execute: async ({ order_id }) => ({
                order_id,
                status: "in_transit",
                delivery: "Friday",
              }),
            }),
          }
        : {},
    }),
    record: false,
  });
  if (!recording)
    assert.equal(
      output.captureFrame,
      original,
      "disabled recording must not wrap the sink",
    );
  const audio = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new AudioFrame(new Int16Array(480).fill(1234), 24000, 1, 480),
      );
      controller.close();
    },
  });
  if (providerMode) {
    if (streamingStt) {
      // Mono 24 kHz s16le speech synthesized by OpenAI for a fictional caller
      // ("Where is my order DEMO 1042?"), followed by two seconds of silence.
      const bytes = Buffer.concat([
        await readFile(new URL("./fixtures/order-24khz.pcm", import.meta.url)),
        Buffer.alloc(96000),
      ]);
      for (let at = 0; at < bytes.length; at += 960) {
        const pcm = new Int16Array(480);
        for (let i = 0; i < 480 && at + i * 2 + 1 < bytes.length; i++)
          pcm[i] = bytes.readInt16LE(at + i * 2);
        inputController.enqueue(new AudioFrame(pcm, 24000, 1, 480));
        // Pace microphone frames to preserve capture timing.
        await sleep(20);
      }
      const transcriptDeadline = Date.now() + 15000;
      while (!/order/i.test(callerTranscript)) {
        if (Date.now() > transcriptDeadline)
          throw new Error("No final STT transcript");
        await sleep(20);
      }
      session.commitUserTurn();
    } else
      await session
        .generateReply({ userInput: "Hi, could you check order 1042 for me?" })
        .waitForPlayout();
    const deadline = Date.now() + 30000;
    while (
      !committed.some(
        (item) =>
          item.role === "assistant" &&
          (process.env.LIVEKIT_INTERRUPT === "1"
            ? item.interrupted
            : /Friday/i.test(item.textContent ?? "")),
      )
    ) {
      if (Date.now() > deadline) throw new Error("No committed order answer");
      await sleep(20);
    }
    await session.activity?.currentSpeech?.waitForPlayout();
    if (process.env.LIVEKIT_RECOVER === "1") {
      await session
        .generateReply({ userInput: "Sorry, please repeat the delivery day." })
        .waitForPlayout();
      assert(
        committed.at(-1)?.role === "assistant" && !committed.at(-1).interrupted,
      );
      assert.match(committed.at(-1).textContent, /Friday/i);
    }
  } else await session.say("Fixture playback", { audio }).waitForPlayout();
  if (process.env.LIVEKIT_SEGMENTS === "1") {
    console.log(
      JSON.stringify({
        playedDurationMs: output.playedSamples / 24,
        completedUploads,
      }),
    );
  }
  if (streamingStt) await session.input.audio?.close();
  await session.close();
  await logger.flush();
  if (provider) assert.equal(telemetry.tracer.getProvider(), provider);
  // LiveKit's job process exits right after its shutdown callbacks, like this;
  // anything not finished by then is lost.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
} finally {
  if (streamingStt) await session.input.audio?.close();
  await session.close();
  await provider?.shutdown();
  await dispose();
  await ws?.close();
}
