import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { wrapDeepgram } from "braintrust";
import {
  runMain,
  runTracedScenario,
  runOperation,
} from "../../helpers/provider-runtime.mjs";

runMain(async () => {
  const sdk = await import(process.env.DEEPGRAM_PACKAGE_NAME);
  const modern = process.env.DEEPGRAM_PACKAGE_NAME.includes("v5");
  const raw = modern
    ? new sdk.DeepgramClient({
        apiKey: process.env.DEEPGRAM_API_KEY,
        baseUrl: process.env.DEEPGRAM_BASE_URL,
        maxRetries: 0,
      })
    : sdk.createClient(process.env.DEEPGRAM_API_KEY, {
        global: {
          fetch: { options: { url: `${process.env.DEEPGRAM_BASE_URL}/` } },
        },
      });
  const client =
    process.env.DEEPGRAM_WRAP === "1" ? wrapDeepgram(wrapDeepgram(raw)) : raw;
  const audioPath = new URL("./test-audio.wav", import.meta.url);
  const options = { model: "nova-3", language: "en" };
  const unwrap = (response) => {
    if (modern) return response;
    if (response.error) throw response.error;
    return response.result;
  };
  await runTracedScenario({
    rootName: "deepgram-instrumentation-root",
    projectNameBase: "tmp-luca",
    metadata: { scenario: "deepgram-instrumentation" },
    callback: async () => {
      if (modern) {
        assert.equal(client.manage, raw.manage);
        assert.equal(client.agent, raw.agent);
        assert.equal(client.listen.v1.connect, raw.listen.v1.connect);
        assert.equal(client.speak.v1.connect, raw.speak.v1.connect);
      } else {
        assert.equal(client.listen.live, raw.listen.live);
        assert.equal(client.speak.live, raw.speak.live);
        assert.equal(
          typeof client.listen.prerecorded.transcribeFileCallback,
          "function",
        );
      }
      for (const source of ["buffer", "stream"])
        await runOperation(`transcribe-${source}`, "transcribe", async () => {
          const file =
            source === "buffer"
              ? await readFile(audioPath)
              : createReadStream(audioPath);
          const response = modern
            ? client.listen.v1.media.transcribeFile(file, options)
            : client.listen.prerecorded.transcribeFile(file, options);
          if (modern) assert.equal(typeof response.withRawResponse, "function");
          const data = unwrap(await response);
          assert.ok(
            data.results.channels[0].alternatives[0].transcript.length > 0,
          );
        });
      await runOperation("transcribe-url", "transcribe", async () => {
        const url = "https://dpgr.am/spacewalk.wav";
        const response = modern
          ? await client.listen.v1.media.transcribeUrl({ url, ...options })
          : await client.listen.prerecorded.transcribeUrl({ url }, options);
        assert.ok(
          unwrap(response).results.channels[0].alternatives[0].transcript
            .length > 0,
        );
      });
      for (const mode of ["stream", ...(modern ? ["arrayBuffer", "blob"] : [])])
        await runOperation(`speech-${mode}`, "speech", async () => {
          const request = {
            text: "Hello.",
            model: "aura-2-thalia-en",
            encoding: "linear16",
            container: "wav",
            sample_rate: 16000,
          };
          const response = modern
            ? await client.speak.v1.audio.generate(request)
            : await client.speak.request({ text: request.text }, request);
          if (mode === "stream") {
            const body = modern
              ? response.stream()
              : await response.getStream();
            let bytes = 0;
            for await (const chunk of body) bytes += chunk.byteLength;
            assert.ok(bytes > 44);
          } else {
            const body = await response[mode]();
            assert.ok((body.byteLength ?? body.size) > 44);
          }
        });
      if (modern && client.speak.v2?.audio)
        await runOperation("speech-v2", "speech", async () => {
          const response = await client.speak.v2.audio.generate({
            text: "Hello.",
            model: "flux-alexis-en",
            encoding: "linear16",
            container: "wav",
            sample_rate: 16000,
          });
          assert.ok((await response.arrayBuffer()).byteLength > 44);
        });
      for (const mode of ["text", "url"])
        await runOperation(`analyze-${mode}`, "analyze", async () => {
          const body =
            mode === "text"
              ? {
                  text: "I am happy with the service. Thank you for helping me today.",
                }
              : {
                  url: "https://raw.githubusercontent.com/deepgram/deepgram-js-sdk/main/LICENSE",
                };
          const options = {
            language: "en",
            sentiment: true,
            topics: true,
            intents: true,
          };
          const response = modern
            ? await client.read.v1.text.analyze({ body, ...options })
            : mode === "text"
              ? await client.read.analyzeText(body, options)
              : await client.read.analyzeUrl(body, options);
          assert.ok(unwrap(response).results.sentiments);
        });
      await runOperation("error", "error", async () => {
        const request = {
          url: "https://dpgr.am/spacewalk.wav",
          model: "braintrust-invalid-model",
        };
        if (modern)
          await assert.rejects(client.listen.v1.media.transcribeUrl(request));
        else
          assert.ok(
            (
              await client.listen.prerecorded.transcribeUrl(
                { url: request.url },
                { model: request.model },
              )
            ).error,
          );
      });
    },
  });
});
