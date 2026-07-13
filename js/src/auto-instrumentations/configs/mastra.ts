import { mastraChannels } from "../../instrumentation/plugins/mastra-channels.js";
import type { ModuleExportPatchConfig } from "../loader/module-hooks/registry.js";

const mastraConstructorPatches = [
  {
    channelName: mastraChannels.mastraConstructor,
    exportName: "Mastra",
    kind: "constructor",
  },
] as const;

export const mastraModuleExportPatchConfigs: readonly ModuleExportPatchConfig[] =
  [
    {
      integrations: ["mastra"],
      modules: [
        {
          packageName: "@mastra/core",
          patches: mastraConstructorPatches,
          source: {
            modulePaths: ["dist/index.js", "dist/index.cjs"],
          },
          specifier: "@mastra/core",
          versionRange: ">=1.20.0",
        },
        {
          packageName: "@mastra/core",
          patches: mastraConstructorPatches,
          source: {
            modulePaths: ["dist/mastra/index.js", "dist/mastra/index.cjs"],
          },
          specifier: "@mastra/core/mastra",
          versionRange: ">=1.20.0",
        },
        {
          packageName: "@mastra/observability",
          patches: [
            {
              channelName: mastraChannels.observabilityConstructor,
              exportName: "Observability",
              kind: "constructor",
            },
          ],
          source: {
            modulePaths: ["dist/index.js", "dist/index.cjs"],
          },
          specifier: "@mastra/observability",
          versionRange: ">=1.20.0",
        },
      ],
      targets: ["node"],
    },
  ];
