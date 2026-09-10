import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { wrapElevenLabs } from "braintrust";
import {
  runMain,
  runTracedScenario,
  runOperation,
} from "../../helpers/provider-runtime.mjs";

runMain(async () => {
  const { ElevenLabsClient, SpeechEngine } = await import(
    process.env.ELEVENLABS_PACKAGE_NAME
  );
  const raw = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
    baseUrl: process.env.ELEVENLABS_BASE_URL,
  });
  const client =
    process.env.ELEVENLABS_WRAP === "1"
      ? wrapElevenLabs(wrapElevenLabs(raw))
      : raw;
  const voice = "JBFqnCBsd6RMkjVDRZzb";
  const request = {
    text: "Hello from Braintrust.",
    modelId: "eleven_flash_v2_5",
    outputFormat: "mp3_44100_128",
  };
  await runTracedScenario({
    rootName: "elevenlabs-instrumentation-root",
    projectNameBase: "tmp-luca-elevenlabs-e2e",
    metadata: { scenario: "elevenlabs-instrumentation" },
    callback: async () => {
      let audio;
      await runOperation("speech", "speech", async () => {
        const promise = client.textToSpeech.convert(voice, request);
        assert.equal(typeof promise.withRawResponse, "function");
        const { data, rawResponse } = await promise.withRawResponse();
        assert.equal(rawResponse.status, 200);
        assert.equal(await promise, data);
        const parts = [];
        const reader = data.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          parts.push(value);
        }
        audio = new Blob(parts, { type: "audio/mpeg" });
        assert.ok(audio.size > 0);
      });
      await runOperation("stream", "stream", async () => {
        const stream = await client.textToSpeech.stream(voice, {
          ...request,
          text: "Streaming from Braintrust.",
        });
        let size = 0;
        for await (const chunk of stream) size += chunk.length;
        assert.ok(size > 0);
      });
      await runOperation("timestamps", "timestamps", async () => {
        const result = await client.textToSpeech.convertWithTimestamps(voice, {
          ...request,
          text: "Timestamped speech.",
        });
        assert.ok(result.audioBase64.length > 0);
        assert.ok(result.alignment.characters.length > 0);
      });
      await runOperation("stream-timestamps", "stream-timestamps", async () => {
        const stream = await client.textToSpeech.streamWithTimestamps(voice, {
          ...request,
          text: "Streaming timestamps.",
        });
        let size = 0;
        for await (const chunk of stream) size += chunk.audioBase64.length;
        assert.ok(size > 0);
      });
      await runOperation("transcribe", "transcribe", async () => {
        const result = await client.speechToText.convert({
          file: new File([audio], "speech.mp3", { type: "audio/mpeg" }),
          modelId: "scribe_v2",
          languageCode: "en",
          timestampsGranularity: "word",
        });
        assert.match(result.text, /hello/i);
      });
      await runOperation("untraced-apis", "untraced-apis", async () => {
        assert.equal(client.speechEngine, raw.speechEngine);
        // Use the real SDK with local transports for deferred APIs. Avoid
        // registering a remote webhook or creating a persistent voice agent.
        const socket = new EventEmitter();
        socket.readyState = 1;
        const sent = [];
        socket.send = (data) => sent.push(JSON.parse(data));
        socket.close = () => socket.emit("close");
        const session = new SpeechEngine.Session(socket);
        let done;
        session.on("user_transcript", function (transcript, signal) {
          assert.ok(this instanceof EventEmitter);
          assert.equal(signal.aborted, false);
          assert.equal(transcript[0].content, "Say hello.");
          done = session.sendResponse("Hello.");
        });
        socket.emit(
          "message",
          JSON.stringify({
            type: "user_transcript",
            event_id: 1,
            user_transcript: [{ role: "user", content: "Say hello." }],
          }),
        );
        await done;
        session.close();
        assert.deepEqual(
          sent.map(({ content }) => content),
          ["Hello.", ""],
        );

        let fetches = 0;
        const webhookSdk = new ElevenLabsClient({
          apiKey: "local-webhook-test",
          fetcher: async ({ method, url }) => {
            fetches++;
            assert.equal(method, "POST");
            assert.ok(url.endsWith("/v1/speech-to-text"));
            return {
              ok: true,
              body: {
                message: "Request accepted",
                request_id: "local-request",
              },
              rawResponse: { status: 200, headers: new Headers() },
            };
          },
        });
        const webhookClient =
          process.env.ELEVENLABS_WRAP === "1"
            ? wrapElevenLabs(webhookSdk)
            : webhookSdk;
        const result = await webhookClient.speechToText.convert({
          modelId: "scribe_v2",
          file: new File([audio], "speech.mp3", { type: "audio/mpeg" }),
          webhook: true,
        });
        assert.equal(result.requestId, "local-request");
        assert.equal(fetches, 1);
      });
      await runOperation("error", "error", async () => {
        await assert.rejects(
          client.textToSpeech.convert(
            voice,
            { ...request, modelId: "braintrust-invalid-model" },
            { maxRetries: 0 },
          ),
          (error) => error.statusCode === 400 || error.statusCode === 422,
        );
      });
    },
  });
});
