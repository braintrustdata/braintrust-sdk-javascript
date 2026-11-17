import { describe, expect, it } from "vite-plus/test";
import { InstrumentationMatcher } from "../../src/auto-instrumentations/orchestrion-js";
import { deepgramConfigs } from "../../src/auto-instrumentations/configs/deepgram";
import { deepgramChannels } from "../../src/instrumentation/providers/deepgram-interceptors";

// Execute transformed public methods, including the CJS and ESM layouts
// present in the published SDKs. Real transport coverage lives in e2e.
describe("Deepgram method transformation", () => {
  for (const version of ["3.13.0", "4.0.0", "4.11.3", "5.0.0", "5.20.0"]) {
    const modern = version.startsWith("5.");
    for (const format of modern ? ["cjs", "esm"] : ["main", "module"]) {
      const methods = modern
        ? [
            [
              "transcribeFile",
              "MediaClient",
              "transcribeFile",
              "listen/resources/v1/resources/media",
            ],
            [
              "transcribeUrl",
              "MediaClient",
              "transcribeUrl",
              "listen/resources/v1/resources/media",
            ],
            [
              "generate",
              "AudioClient",
              "generate",
              "speak/resources/v1/resources/audio",
            ],
            [
              "analyze",
              "TextClient",
              "analyze",
              "read/resources/v1/resources/text",
            ],
            ...(version === "5.20.0"
              ? [
                  [
                    "generateV2",
                    "AudioClient",
                    "generate",
                    "speak/resources/v2/resources/audio",
                  ],
                ]
              : []),
          ]
        : [
            ["legacyTranscribeFile", "ListenRestClient", "transcribeFile"],
            ["legacyTranscribeUrl", "ListenRestClient", "transcribeUrl"],
            ["legacySpeak", "SpeakClient", "request"],
            ["legacyAnalyzeText", "ReadRestClient", "analyzeText"],
            ["legacyAnalyzeUrl", "ReadRestClient", "analyzeUrl"],
          ];
      for (const [key, className, method, resource] of methods)
        it(`${version} ${format} ${key}`, () => {
          const path = modern
            ? `dist/${format}/api/resources/${resource}/client/Client.${format === "esm" ? "mjs" : "js"}`
            : `dist/${format}/packages/${className}.js`;
          const transformer = new InstrumentationMatcher(
            deepgramConfigs,
          ).getTransformer("@deepgram/sdk", version, path)!;
          const code = transformer.transform(
            `class ${className} {
          #value = 17;
          ${method}(request) { return { receiver: this, value: this.#value, request }; }
          connect() { return this.#value; }
          ${method}Callback() { return this.#value; }
        }
        globalThis.__deepgramTestClient = new ${className}();`,
            format === "esm" || format === "module" ? "esm" : "cjs",
          ).code;
          let calls = 0;
          const hook = deepgramChannels[key as keyof typeof deepgramChannels];
          const remove = hook.intercept((target, receiver, args) => {
            calls++;
            return Reflect.apply(target, receiver, args);
          });
          try {
            const scope = globalThis as typeof globalThis & {
              __deepgramTestClient?: any;
            };
            Function(code)();
            const client = scope.__deepgramTestClient;
            delete scope.__deepgramTestClient;
            const request = { text: "hello" };
            const result = client[method](request);
            expect(result).toEqual({ receiver: client, value: 17, request });
            expect(result.request).toBe(request);
            expect(client.connect()).toBe(17);
            expect(client[`${method}Callback`]()).toBe(17);
            expect(calls).toBe(1);
          } finally {
            remove();
          }
        });
    }
  }
});
