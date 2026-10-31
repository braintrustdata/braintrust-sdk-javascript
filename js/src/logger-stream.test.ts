import { expect, test } from "vitest";
import { BraintrustState, initLogger } from "./node";

test.each([
  ["ASCII", "Hello, world!", false],
  ["single-chunk Unicode", "Пам’ять 🧠 漢字", false],
  ["split Unicode", "Пам’ять 🧠 漢字", true],
])(
  "logs a byte stream without changing its text: %s",
  async (_, text, split) => {
    const rows: { output?: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/version") {
        return Response.json({ logs3_payload_max_bytes: 6 * 1024 * 1024 });
      }
      if (path === "/logs3") {
        rows.push(...JSON.parse(String(init?.body)).rows);
        return Response.json({});
      }
      throw new Error(`Unexpected request: ${input}`);
    };
    const state = BraintrustState.deserialize(
      {
        appUrl: "https://app.test",
        appPublicUrl: "https://app.test",
        apiUrl: "https://api.test",
        proxyUrl: "https://api.test",
        orgName: "test-org",
        orgId: "test-org-id",
        loginToken: "test-token-not-a-real-credential",
      },
      { fetch, noExitFlush: true },
    );
    const logger = initLogger({
      projectName: "test-project",
      projectId: "test-project-id",
      state,
      setCurrent: false,
      environment: { type: "test", name: "synthetic" },
    });
    const bytes = new TextEncoder().encode(text);
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        if (split) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        } else {
          controller.enqueue(bytes);
        }
        controller.close();
      },
    });
    const span = logger.startSpan({ name: "byte-stream" });
    span.log({ output });
    span.end();
    await logger.flush();

    expect(rows).toHaveLength(1);
    expect(rows[0].output).toBe(text);
  },
);
