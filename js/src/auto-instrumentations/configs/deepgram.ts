import type { InstrumentationConfig } from "../orchestrion-js";
import { deepgramChannels } from "../../instrumentation/providers/deepgram-interceptors";

export const deepgramConfigs: InstrumentationConfig[] = [
  ...(["main", "module"] as const).flatMap((format) =>
    (
      [
        ["legacyTranscribeFile", "ListenRestClient", "transcribeFile"],
        ["legacyTranscribeUrl", "ListenRestClient", "transcribeUrl"],
        ["legacySpeak", "SpeakClient", "request"],
        ["legacyAnalyzeText", "ReadRestClient", "analyzeText"],
        ["legacyAnalyzeUrl", "ReadRestClient", "analyzeUrl"],
      ] as const
    ).map(([hook, className, methodName]) => ({
      channelName: deepgramChannels[hook].channelName,
      module: {
        name: "@deepgram/sdk",
        versionRange: ">=3.13.0 <5.0.0",
        filePath: `dist/${format}/packages/${className}.js`,
      },
      functionQuery: { className, methodName },
    })),
  ),
  ...(["cjs", "esm"] as const).flatMap((format) =>
    (
      [
        [
          "transcribeFile",
          "listen",
          "v1",
          "media",
          "MediaClient",
          "transcribeFile",
        ],
        [
          "transcribeUrl",
          "listen",
          "v1",
          "media",
          "MediaClient",
          "transcribeUrl",
        ],
        ["generate", "speak", "v1", "audio", "AudioClient", "generate"],
        ["generateV2", "speak", "v2", "audio", "AudioClient", "generate"],
        ["analyze", "read", "v1", "text", "TextClient", "analyze"],
      ] as const
    ).map(([hook, resource, version, child, className, methodName]) => ({
      channelName: deepgramChannels[hook].channelName,
      module: {
        name: "@deepgram/sdk",
        versionRange: version === "v2" ? ">=5.6.0 <6.0.0" : ">=5.0.0 <6.0.0",
        filePath: `dist/${format}/api/resources/${resource}/resources/${version}/resources/${child}/client/Client.${format === "esm" ? "mjs" : "js"}`,
      },
      functionQuery: { className, methodName },
    })),
  ),
];
