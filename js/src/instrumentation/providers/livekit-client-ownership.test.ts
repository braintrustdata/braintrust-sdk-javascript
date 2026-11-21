import OpenAI from "openai";
import { describe, expect, test } from "vite-plus/test";
import {
  liveKitUsesCoveredClient,
  recordLiveKitOpenAIClient,
} from "./livekit-client-ownership";

describe("public adapter client ownership", () => {
  for (const kind of ["llm", "stt", "tts"] as const) {
    const method =
      kind === "llm" ? "chat" : kind === "stt" ? "recognize" : "synthesize";
    for (const client of ["default", "sdk", "custom"] as const)
      test(`${kind} records ${client} client ownership before execution`, () => {
        class Adapter {
          [key: string]: unknown;
          [method]() {
            throw new Error("ownership must not execute the operation");
          }
        }
        const service = new Adapter();
        const options =
          client === "default"
            ? undefined
            : {
                client:
                  client === "sdk"
                    ? new OpenAI({ apiKey: "unit" })
                    : {
                        chat: { completions: { create() {} } },
                        audio: {
                          transcriptions: { create() {} },
                          speech: { create() {} },
                        },
                      },
              };
        recordLiveKitOpenAIClient(service, Adapter, options, kind);
        expect(
          liveKitUsesCoveredClient(service, kind, method, service[method]),
        ).toBe(client !== "custom");
      });
  }

  test("stock streaming recognition owns its transport independently of the SDK client", () => {
    class Adapter {
      [key: string]: unknown;
      recognize() {}
      stream() {}
    }
    const service = new Adapter();
    recordLiveKitOpenAIClient(service, Adapter, undefined, "stt");
    expect(
      liveKitUsesCoveredClient(service, "stt", "recognize", service.recognize),
    ).toBe(true);
    expect(
      liveKitUsesCoveredClient(service, "stt", "stream", service.stream),
    ).toBe(false);
  });

  test("a factory observation cannot replace the constructor's injected client", () => {
    class Adapter {
      [key: string]: unknown;
      synthesize() {}
    }
    const service = new Adapter();
    recordLiveKitOpenAIClient(service, Adapter, { client: {} }, "tts");
    recordLiveKitOpenAIClient(service, Adapter, undefined, "tts");
    expect(
      liveKitUsesCoveredClient(
        service,
        "tts",
        "synthesize",
        service.synthesize,
      ),
    ).toBe(false);
  });

  test("an overridden operation cannot inherit the base constructor's SDK ownership", () => {
    class Adapter {
      [key: string]: unknown;
      recognize() {}
      _recognize() {}
    }
    class CustomAdapter extends Adapter {
      override _recognize() {}
    }
    const service = new CustomAdapter();
    recordLiveKitOpenAIClient(service, Adapter, undefined, "stt");
    expect(
      liveKitUsesCoveredClient(service, "stt", "recognize", service.recognize),
    ).toBe(false);
  });
});
