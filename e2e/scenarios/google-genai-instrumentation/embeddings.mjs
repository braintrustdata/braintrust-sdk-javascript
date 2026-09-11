import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runOperation } from "../../helpers/provider-runtime.mjs";

export const GOOGLE_MULTIMODAL_EMBEDDING_MODEL = "gemini-embedding-2";
export const EMBEDDING_DIMENSIONS = 768;

// Valid media fixtures, recorded against the real Google embedding model:
// - test-image.png: the existing ship-in-a-storm scenario image.
// - test-audio.wav: the 1.81-second speech sample converted to mono 16 kHz PCM, from
//   https://storage.googleapis.com/cloud-samples-data/speech/brooklyn_bridge.wav
// - test-video.mp4: first 2 seconds, 160px wide at 5 fps, H.264 without audio, from
//   https://storage.googleapis.com/cloud-samples-data/video/animals.mp4
// - test-document.pdf: copied from js/src/wrappers/ai-sdk/fixtures/test-document.pdf.
export async function runMultimodalEmbeddings(client, imageBase64) {
  const contents = [
    {
      parts: [
        { text: "A sailing ship in a storm" },
        { inlineData: { mimeType: "image/png", data: imageBase64 } },
      ],
    },
    ...(await Promise.all(
      [
        ["test-audio.wav", "audio/wav"],
        ["test-video.mp4", "video/mp4"],
        ["test-document.pdf", "application/pdf"],
      ].map(async ([filename, mimeType]) => ({
        parts: [
          {
            inlineData: {
              mimeType,
              data: (
                await readFile(new URL(filename, import.meta.url))
              ).toString("base64"),
            },
          },
        ],
      })),
    )),
  ];
  await runOperation(
    "google-multimodal-embed-operation",
    "multimodal-embed",
    async () => {
      const result = await client.models.embedContent({
        model: GOOGLE_MULTIMODAL_EMBEDDING_MODEL,
        contents,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      assert.equal(result.embeddings.length, contents.length);
      for (const embedding of result.embeddings) {
        assert.equal(embedding.values.length, EMBEDDING_DIMENSIONS);
        assert.ok(embedding.values.every(Number.isFinite));
        assert.ok(embedding.values.some((value) => value !== 0));
      }
    },
  );
}
