import type { InstrumentationConfig } from "../orchestrion-js";
import {
  e2bChannels,
  e2bCodeInterpreterChannels,
} from "../../instrumentation/plugins/e2b-channels";

export const e2bConfigs: InstrumentationConfig[] = [
  "dist/index.js",
  "dist/index.mjs",
].flatMap((filePath) => [
  {
    channelName: e2bChannels.create.channelName,
    module: { name: "e2b", versionRange: ">=2.9.0 <3.0.0", filePath },
    functionQuery: {
      className: "Sandbox",
      methodName: "create",
      kind: "Async",
    },
  },
  {
    channelName: e2bChannels.run.channelName,
    module: { name: "e2b", versionRange: ">=2.9.0 <3.0.0", filePath },
    functionQuery: { className: "Commands", methodName: "run", kind: "Async" },
  },
  {
    // Code Interpreter inherits create() and commands from e2b.
    channelName: e2bCodeInterpreterChannels.runCode.channelName,
    module: {
      name: "@e2b/code-interpreter",
      versionRange: ">=2.2.0 <3.0.0",
      filePath,
    },
    functionQuery: {
      className: "Sandbox",
      methodName: "runCode",
      kind: "Async",
    },
  },
]);
