import { describe, expect, it } from "vitest";
import { mastraChannels } from "../../instrumentation/plugins/mastra-channels";
import { getModuleExportPatchSpecifiers } from "../loader/module-hooks/registry";
import { getDefaultModuleExportPatchConfigs } from "./all";
import { mastraModuleExportPatchConfigs } from "./mastra";

describe("module export patch configs", () => {
  it("registers versioned Mastra constructor channels for Node", () => {
    const configs = getDefaultModuleExportPatchConfigs({ target: "node" });

    expect(configs).toEqual(mastraModuleExportPatchConfigs);
    expect(getModuleExportPatchSpecifiers(configs)).toEqual([
      "@mastra/core",
      "@mastra/core/mastra",
      "@mastra/observability",
    ]);
    expect(configs[0].modules.map((module) => module.versionRange)).toEqual([
      ">=1.20.0",
      ">=1.20.0",
      ">=1.20.0",
    ]);
    expect(configs[0].modules.map((module) => module.patches)).toEqual([
      [
        {
          channelName: mastraChannels.mastraConstructor,
          exportName: "Mastra",
          kind: "constructor",
        },
      ],
      [
        {
          channelName: mastraChannels.mastraConstructor,
          exportName: "Mastra",
          kind: "constructor",
        },
      ],
      [
        {
          channelName: mastraChannels.observabilityConstructor,
          exportName: "Observability",
          kind: "constructor",
        },
      ],
    ]);
  });

  it("filters Mastra configs for browser and disabled integrations", () => {
    expect(getDefaultModuleExportPatchConfigs({ target: "browser" })).toEqual(
      [],
    );
    expect(
      getDefaultModuleExportPatchConfigs({
        disabledIntegrationConfig: { mastra: false },
        target: "node",
      }),
    ).toEqual([]);
  });
});
