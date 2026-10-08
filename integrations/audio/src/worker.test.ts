import { expect, test } from "vitest";
import { createEncoder } from "./worker";
test("worker admission permits one running and one queued job, without blocking a caller", async () => {
  const encoder = createEncoder();
  const packet = () => [
    {
      pcm: new Int16Array(24000).fill(1234),
      rate: 24000,
      channels: 1,
      channel: 0,
      at: 0,
    },
  ];
  const results = await Promise.allSettled([
    encoder(packet(), 1000),
    encoder(packet(), 1000),
    encoder(packet(), 1000),
  ]);
  expect(results.map((r) => r.status)).toEqual([
    "fulfilled",
    "fulfilled",
    "rejected",
  ]);
  const first = results[0];
  if (first.status === "fulfilled") {
    expect(first.value.bytes.length).toBe(96044);
  }
  expect(results[2]).toMatchObject({
    reason: { message: "recording_worker_capacity" },
  });
});

test("a failed codec releases admission for subsequent recordings", async () => {
  await expect(
    createEncoder({ module: "file:///missing-braintrust-test-codec.mjs" })(
      [],
      20,
    ),
  ).rejects.toThrow();
  const result = await createEncoder()([], 20);
  expect(result.mimeType).toBe("audio/wav");
  expect(result.bytes.length).toBe(1964);
});

test("successive segments reuse the codec runtime but keep independent output buffers", async () => {
  const encoder = createEncoder({
    module: new URL("./fixtures/counting-codec.mjs", import.meta.url).href,
  });
  const first = await encoder([], 20);
  const second = await encoder([], 20);
  expect([...first.bytes]).toEqual([1]);
  expect([...second.bytes]).toEqual([2]);
});
