import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  wrapLiveKitAgents,
  startLiveKitSessionTrace,
  startLiveKitTurnTrace,
  captureLiveKitTrace,
  withCurrent,
  flush,
} from "braintrust";
import {
  runMain,
  runTracedScenario,
  runOperation,
} from "../../helpers/provider-runtime.mjs";

runMain(async () => {
  // Multipart requests exceed the cassette layer's inline-body threshold.
  // Stabilize only their random transport boundary before hashing; preserve
  // every form field and audio byte sent to the real provider.
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const contentType = request.headers.get("content-type") ?? "";
    const boundary = contentType.match(/boundary="?([^";]+)/)?.[1];
    if (!contentType.startsWith("multipart/form-data") || !boundary)
      return fetch(request);
    const body = Buffer.from(await request.arrayBuffer())
      .toString("latin1")
      .replaceAll(boundary, "livekit-e2e-boundary");
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set(
      "content-type",
      "multipart/form-data; boundary=livekit-e2e-boundary",
    );
    return fetch(
      new Request(request, { headers, body: Buffer.from(body, "latin1") }),
    );
  };
  const require = createRequire(import.meta.url);
  const load = async (name) =>
    process.env.LIVEKIT_CJS === "1" ? require(name) : import(name);
  const raw = await load("@livekit/agents");
  const openai = await load("@livekit/agents-plugin-openai");
  const silero = await load("@livekit/agents-plugin-silero");
  const { AudioFrame, dispose } = await import("@livekit/rtc-node");
  raw.initializeLogger({ pretty: false, level: "error" });
  const sdk = process.env.LIVEKIT_WRAP === "1" ? wrapLiveKitAgents(raw) : raw;
  const { voice, llm } = sdk;
  const baseURL = process.env.OPENAI_BASE_URL;
  const useInference = process.env.LIVEKIT_INFERENCE === "1";
  const credentials =
    process.env.BRAINTRUST_E2E_CASSETTE_MODE === "replay"
      ? { apiKey: "cassette-placeholder", apiSecret: "cassette-placeholder" }
      : {};
  const model = useInference
    ? new sdk.inference.LLM({
        model: "openai/gpt-4.1-nano",
        baseURL: process.env.LIVEKIT_INFERENCE_URL,
        modelOptions: {
          temperature: 0,
          max_completion_tokens: 80,
          parallel_tool_calls: false,
        },
        ...credentials,
      })
    : new openai.LLM({
        model: "gpt-4.1-nano",
        temperature: 0,
        maxCompletionTokens: 80,
        baseURL,
      });
  const tts = useInference
    ? new sdk.inference.TTS({
        model: "cartesia/sonic-3",
        voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
        baseURL: process.env.LIVEKIT_SPEECH_BASE_URL,
        ...credentials,
      })
    : new openai.TTS({ model: "tts-1", voice: "alloy", baseURL });
  const stt = useInference
    ? new sdk.inference.STT({
        model: "deepgram/nova-3",
        language: "en",
        baseURL: process.env.LIVEKIT_SPEECH_BASE_URL,
        ...credentials,
      })
    : new openai.STT({
        model: "whisper-1",
        useRealtime: false,
        language: "en",
        baseURL,
      });
  if (!useInference) {
    // Keep provider identity independent of the cassette transport's localhost URL.
    for (const provider of [model, tts, stt])
      Object.defineProperty(provider, "provider", { get: () => "openai" });
  }
  const vad = await silero.VAD.load();
  const tool = llm.tool({
    name: "lookup_weather",
    description: "Get the weather in Paris.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => ({ weather: "sunny", temperature: 20 }),
  });
  const agent = new voice.Agent({
    instructions:
      "Use lookup_weather for weather questions. After the result, reply with one short sentence.",
    tools: [tool],
    llm: model,
    stt,
    tts,
    vad,
  });
  const session = new voice.AgentSession({
    llm: model,
    stt,
    tts,
    vad,
    turnDetection: "manual",
  });
  let voiceAudioController;
  if (useInference) {
    // Configure input before start, as required by older supported SDKs.
    session.input.audio = {
      stream: new ReadableStream({
        start(controller) {
          voiceAudioController = controller;
        },
      }),
      onAttached() {},
      onDetached() {},
      setAttached() {},
      async close() {},
    };
  }
  // Session error events include model instances and their credentials. Reject
  // with the underlying error message, never the full event object.
  const sessionFailure = new Promise((_, reject) => {
    session.on("error", ({ error }) =>
      reject(new Error(error.error?.message ?? "LiveKit session failed")),
    );
  });
  void sessionFailure.catch(() => {});
  try {
    await runTracedScenario({
      rootName: "livekit-session",
      projectNameBase: "tmp-luca-livekit-e2e",
      metadata: { scenario: "livekit-agents-instrumentation" },
      callback: async () => {
        const sessionTrace = startLiveKitSessionTrace({
          sessionId: "capture-session",
        });
        const exercise = async () => {
          await session.start({ agent, record: false });
          const userInput = "Use lookup_weather to check the weather in Paris.";
          const turnTrace = startLiveKitTurnTrace({
            parent: sessionTrace,
            operation: "run",
            input: userInput,
          });
          const result = await withCurrent(turnTrace, () =>
            session.run({ userInput }).wait(),
          );
          const exported = await turnTrace.export();
          await flush();
          // Finish in another process with no loader hook or LiveKit SDK import.
          // Send context through stdin, not command arguments or log output.
          const worker = spawn(
            process.execPath,
            [new URL("./capture-outcome.mjs", import.meta.url).pathname],
            { stdio: ["pipe", "ignore", "pipe"] },
          );
          const workerDone = new Promise((resolve, reject) => {
            worker.on("error", reject);
            worker.on("exit", (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`Capture worker exited with ${code}`)),
            );
          });
          worker.stderr.resume();
          worker.stdin.end(
            JSON.stringify({
              span: exported,
              status: "completed",
              output: result.events.map((event) => event.item).filter(Boolean),
              endTime: Date.now() / 1000,
            }),
          );
          await workerDone;
          await runOperation("vision", "vision", async () => {
            const bytes = await readFile(
              new URL("./test-image.png", import.meta.url),
            );
            const chatCtx = new llm.ChatContext();
            chatCtx.addMessage({
              role: "user",
              content: [
                "Describe the image in five words.",
                llm.createImageContent({
                  image: `data:image/png;base64,${bytes.toString("base64")}`,
                }),
              ],
            });
            const stream = await voice.Agent.default.llmNode(
              agent,
              chatCtx,
              new llm.ToolContext(),
              {},
            );
            let text = "";
            for await (const chunk of stream)
              text += chunk.delta?.content ?? "";
            assert.ok(text.length);
          });
          const audio = [];
          await runOperation("speech", "speech", async () => {
            const input = new ReadableStream({
              start(controller) {
                controller.enqueue("Hello from Braintrust.");
                controller.close();
              },
            });
            const stream = await agent.ttsNode(input, {});
            // Exercise Web Streams piping, which bypasses async iteration.
            await stream.pipeTo(
              new WritableStream({
                write(frame) {
                  audio.push(
                    new AudioFrame(
                      new Int16Array(frame.data),
                      frame.sampleRate,
                      frame.channels,
                      frame.samplesPerChannel,
                    ),
                  );
                },
              }),
            );
            assert.ok(audio.length);
          });
          await runOperation("transcription", "transcription", async () => {
            const first = audio[0];
            // A short silence lets the real VAD close the utterance.
            audio.push(
              new AudioFrame(
                new Int16Array(first.sampleRate * first.channels),
                first.sampleRate,
                first.channels,
                first.sampleRate,
              ),
            );
            const input = new ReadableStream({
              start(controller) {
                for (const frame of audio) controller.enqueue(frame);
                controller.close();
              },
            });
            const stream = await agent.sttNode(input, {});
            const reader = stream.getReader();
            let transcript = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.type === 2) {
                transcript += value.alternatives[0]?.text ?? "";
                await reader.cancel();
                break;
              }
            }
            assert.ok(transcript.trim().length);
          });
          if (useInference) {
            // The application owns both listeners and the audio input. Capture
            // only receives plain snapshots extracted from the real events.
            let transcript = "";
            let committed = false;
            const voiceDone = new Promise((resolve, reject) => {
              session.on("user_input_transcribed", (event) => {
                if (!event.isFinal || committed) return;
                transcript = event.transcript;
                committed = true;
                session.commitUserTurn();
              });
              session.once("speech_created", ({ speechHandle, createdAt }) => {
                const turn = startLiveKitTurnTrace({
                  parent: sessionTrace,
                  operation: "voice",
                  speechId: speechHandle.id,
                  input: transcript,
                  startTime: createdAt / 1000,
                });
                // Capture neither subscribes to nor waits on the handle.
                speechHandle.waitForPlayout().then(() => {
                  const error = speechHandle.exception?.();
                  captureLiveKitTrace({
                    span: turn,
                    status: error
                      ? "failed"
                      : speechHandle.interrupted
                        ? "interrupted"
                        : "completed",
                    output: speechHandle.chatItems,
                    ...(error ? { error } : {}),
                  });
                  if (error) reject(error);
                  else resolve();
                }, reject);
              });
            });
            for (const frame of audio) voiceAudioController.enqueue(frame);
            voiceAudioController.close();
            let timeout;
            try {
              await Promise.race([
                voiceDone,
                new Promise((_, reject) => {
                  timeout = setTimeout(
                    () =>
                      reject(
                        new Error(
                          `Voice turn timed out (transcript received: ${committed})`,
                        ),
                      ),
                    30_000,
                  );
                }),
              ]);
              assert.ok(transcript.trim().length);
            } finally {
              clearTimeout(timeout);
              session.input.audio = null;
            }
          }
        };
        try {
          await withCurrent(sessionTrace, () =>
            Promise.race([exercise(), sessionFailure]),
          );
          captureLiveKitTrace({
            span: sessionTrace,
            status: "pending",
            output: session.history.items,
          });
        } catch (error) {
          captureLiveKitTrace({ span: sessionTrace, status: "failed", error });
          throw error;
        } finally {
          await session.close();
        }
        captureLiveKitTrace({
          span: sessionTrace,
          status: "completed",
          output: session.history.items,
        });
      },
    });
  } finally {
    if (useInference) {
      await stt.close();
      await tts.close();
    }
    dispose();
  }
});
