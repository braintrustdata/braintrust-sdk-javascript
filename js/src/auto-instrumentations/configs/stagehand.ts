import type { InstrumentationConfig } from "../orchestrion-js";
import { stagehandChannels } from "../../instrumentation/plugins/stagehand-channels";

const stagehandV30VersionRange = ">=3.0.0 <3.1.0";
const stagehandV31VersionRange = ">=3.1.0 <4.0.0";

const methods = [
  ["act", stagehandChannels.act.channelName, "Async"],
  ["extract", stagehandChannels.extract.channelName, "Async"],
  ["observe", stagehandChannels.observe.channelName, "Async"],
  ["agent", stagehandChannels.agent.channelName, "Sync"],
] as const;

/** Instrumentation configurations for @browserbasehq/stagehand v3. */
export const stagehandConfigs: InstrumentationConfig[] = [
  ...methods.map(([methodName, channelName, kind]) => ({
    channelName,
    module: {
      name: "@browserbasehq/stagehand",
      versionRange: stagehandV30VersionRange,
      filePath: "dist/index.js",
    },
    functionQuery: {
      className: "_V3",
      methodName,
      kind,
    },
  })),
  ...["esm", "cjs"].flatMap((moduleKind) =>
    methods.map(([methodName, channelName, kind]) => ({
      channelName,
      module: {
        name: "@browserbasehq/stagehand",
        versionRange: stagehandV31VersionRange,
        filePath: `dist/${moduleKind}/lib/v3/v3.js`,
      },
      functionQuery: {
        className: "V3",
        methodName,
        kind,
      },
    })),
  ),
];
