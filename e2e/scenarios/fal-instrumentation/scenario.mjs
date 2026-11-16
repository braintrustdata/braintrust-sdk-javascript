import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { wrapFal } from "braintrust";
import {
  runMain,
  runTracedScenario,
  runOperation,
} from "../../helpers/provider-runtime.mjs";

runMain(async () => {
  const { fal, createFalClient } = await import(process.env.FAL_PACKAGE_NAME);
  const config = {
    credentials: process.env.FAL_KEY,
    // Route the actual SDK requests through the cassette server. Never fall
    // through to a live provider when the replay lane has no recorded response.
    requestMiddleware: async (request) => {
      const url = new URL(request.url);
      const base =
        url.origin === "https://fal.run" ? process.env.FAL_BASE_URL : undefined;
      assert.ok(base, `Unexpected fal origin: ${url.origin}`);
      return { ...request, url: `${base}${url.pathname}${url.search}` };
    },
  };
  fal.config(config);
  const raw = createFalClient(config);
  const client = process.env.FAL_WRAP === "1" ? wrapFal(wrapFal(raw)) : raw;
  const singleton = process.env.FAL_WRAP === "1" ? wrapFal(fal) : fal;
  assert.equal(client.queue, raw.queue);
  assert.equal(client.realtime, raw.realtime);
  assert.equal(client.storage, raw.storage);
  await runTracedScenario({
    rootName: "fal-instrumentation-root",
    projectNameBase: "tmp-luca",
    metadata: { scenario: "fal-instrumentation" },
    callback: async () => {
      await runOperation("image", "image", async () => {
        const result = await singleton.run("fal-ai/flux/schnell", {
          input: {
            prompt: "A red cube on a white background",
            image_size: { width: 256, height: 256 },
            num_inference_steps: 1,
            seed: 42,
          },
        });
        assert.ok(result.data.images[0].url);
        assert.ok(result.requestId);
      });
      await runOperation("audio", "audio", async () => {
        const result = await client.run("fal-ai/kokoro/american-english", {
          input: {
            prompt: "Hello from Braintrust.",
            voice: "af_heart",
            speed: 1,
          },
        });
        assert.ok(result.data.audio.url);
      });
      await runOperation("video", "video", async () => {
        const image = await readFile(
          new URL("./test-image.png", import.meta.url),
        );
        const result = await client.run(
          "fal-ai/ltx-video-13b-distilled/image-to-video",
          {
            input: {
              prompt: "The scene moves slowly. The camera stays still.",
              image_url: `data:image/png;base64,${image.toString("base64")}`,
              num_frames: 9,
              resolution: "480p",
              first_pass_num_inference_steps: 2,
              seed: 42,
            },
          },
        );
        assert.ok(result.data.video.url);
      });
      for (const mode of ["iterator", "done", "events"]) {
        await runOperation(`stream-${mode}`, "stream", async () => {
          const owner = mode === "events" ? client.streaming : client;
          const stream = await owner.stream("fal-ai/flux-lora", {
            input: {
              prompt: "A blue cube on a white background",
              image_size: { width: 256, height: 256 },
              num_inference_steps: 2,
              seed: 42,
            },
          });
          const done = stream.done();
          // Attach rejection handling immediately; done() remains the provider's promise.
          void done.catch(() => {});
          let count = 0;
          if (mode === "events")
            stream.on("data", () => {
              count++;
            });
          if (mode === "iterator")
            for await (const event of stream) {
              assert.ok(event);
              count++;
            }
          const result = await done;
          assert.ok(result.images?.length);
          if (mode !== "done") assert.ok(count > 0);
        });
      }
      await runOperation("error", "error", async () => {
        await assert.rejects(
          client.run("fal-ai/flux/schnell", { input: {} }),
          (error) => error.status === 422,
        );
      });
    },
  });
});
