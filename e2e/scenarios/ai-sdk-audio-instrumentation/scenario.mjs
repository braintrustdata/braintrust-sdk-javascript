import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { currentSpan, wrapAISDK } from "braintrust";
import { runMain, runTracedScenario } from "../../helpers/provider-runtime.mjs";

const mode = process.env.AI_SDK_AUDIO_MODE;
const aiModule = mode.endsWith("-cjs")
  ? createRequire(import.meta.url)(process.env.AI_SDK_PACKAGE_NAME)
  : await import(process.env.AI_SDK_PACKAGE_NAME);
const { createOpenAI } = await import(process.env.AI_SDK_OPENAI_PACKAGE_NAME);
const ai = mode.startsWith("auto-hook") ? aiModule : wrapAISDK(aiModule);
const outputFormat = process.env.AI_SDK_PACKAGE_NAME.startsWith("ai-sdk-v4")
  ? "wav"
  : "mp3";
const openai = createOpenAI({ baseURL: process.env.OPENAI_BASE_URL });

runMain(async () => {
  await runTracedScenario({
    projectNameBase: "tmp-luca",
    rootName: "ai-sdk-audio",
    metadata: { scenario: "ai-sdk-audio-instrumentation" },
    callback: async () => {
      const parent = currentSpan().spanId;
      for (const capture of [false, true]) {
        process.env.BRAINTRUST_CAPTURE_ATTACHMENTS = "true";
        process.env.BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS = String(capture);
        process.env.BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS =
          String(capture);
        // Exercise v7's deprecated aliases too. Earlier versions only export aliases.
        const generateSpeech =
          !capture && ai.generateSpeech
            ? ai.generateSpeech
            : ai.experimental_generateSpeech;
        const transcribe =
          !capture && ai.transcribe
            ? ai.transcribe
            : ai.experimental_transcribe;
        const speech = await generateSpeech({
          model: openai.speech("gpt-4o-mini-tts"),
          text: "Hello. This is a short audio test.",
          voice: "alloy",
          outputFormat,
          maxRetries: 0,
        });
        assert.equal(currentSpan().spanId, parent);
        assert.match(
          speech.audio.mediaType ?? speech.audio.mimeType,
          /^audio\/(mpeg|mp3|wav)$/,
        );
        assert.ok(speech.audio.uint8Array.byteLength > 100);
        assert.deepEqual(
          Buffer.from(speech.audio.base64, "base64"),
          Buffer.from(speech.audio.uint8Array),
        );
        // The input is real, decodable speech from the preceding provider call.
        const result = await transcribe({
          model: openai.transcription("gpt-4o-mini-transcribe"),
          audio: capture ? speech.audio.base64 : speech.audio.uint8Array,
          maxRetries: 0,
        });
        assert.equal(currentSpan().spanId, parent);
        assert.match(result.text, /hello/i);
        assert.ok(Array.isArray(result.segments));
      }
    },
  });
});
