import type { InstrumentationConfig } from "@apm-js-collab/code-transformer";
import { mastraChannels } from "../../instrumentation/plugins/mastra-channels";
import { mastraAssignedAsyncTransformName } from "../custom-transforms";

const mastraPackageName = "@mastra/core";

const stableVersionRange = "1.26.0";
const alphaVersionRange = "1.26.1-alpha.0";

const stableAgentWorkflowChunks = [
  { filePath: "dist/chunk-CXW3Z2OL.js", moduleType: "esm" },
  { filePath: "dist/chunk-PBGNXXU5.cjs", moduleType: "cjs" },
] as const;

const alphaAgentWorkflowChunks = [
  { filePath: "dist/chunk-4QTY73BW.js", moduleType: "esm" },
  { filePath: "dist/chunk-7432OHPH.cjs", moduleType: "cjs" },
] as const;

const toolChunks = [
  { filePath: "dist/chunk-O3JJ5ZPY.js", moduleType: "esm" },
  { filePath: "dist/chunk-U7Z7GCXY.cjs", moduleType: "cjs" },
] as const;

function config(
  channelName: string,
  versionRange: string,
  filePath: string,
  functionQuery: InstrumentationConfig["functionQuery"],
  transform?: string,
): InstrumentationConfig {
  return {
    channelName,
    module: {
      name: mastraPackageName,
      versionRange,
      filePath,
    },
    functionQuery,
    ...(transform ? { transform } : {}),
  };
}

function agentWorkflowConfigs(
  versionRange: string,
  chunks: readonly { filePath: string }[],
): InstrumentationConfig[] {
  return chunks.flatMap(({ filePath }) => [
    config(mastraChannels.agentExecute.channelName, versionRange, filePath, {
      className: "Agent",
      privateMethodName: "execute",
      kind: "Async",
    }),
    config(mastraChannels.agentNetwork.channelName, versionRange, filePath, {
      className: "Agent",
      methodName: "network",
      kind: "Async",
    }),
    config(
      mastraChannels.agentResumeNetwork.channelName,
      versionRange,
      filePath,
      {
        className: "Agent",
        methodName: "resumeNetwork",
        kind: "Async",
      },
    ),
    config(
      mastraChannels.agentGenerateLegacy.channelName,
      versionRange,
      filePath,
      {
        className: "Agent",
        methodName: "generateLegacy",
        kind: "Async",
      },
    ),
    config(
      mastraChannels.agentStreamLegacy.channelName,
      versionRange,
      filePath,
      {
        className: "Agent",
        methodName: "streamLegacy",
        kind: "Async",
      },
    ),
    config(
      mastraChannels.workflowRunStart.channelName,
      versionRange,
      filePath,
      {
        className: "Run",
        methodName: "_start",
        kind: "Async",
      },
    ),
    config(
      mastraChannels.workflowRunResume.channelName,
      versionRange,
      filePath,
      {
        className: "Run",
        methodName: "_resume",
        kind: "Async",
      },
    ),
    config(
      mastraChannels.workflowRunRestart.channelName,
      versionRange,
      filePath,
      {
        className: "Run",
        methodName: "_restart",
        kind: "Async",
      },
    ),
    config(
      mastraChannels.workflowStepExecute.channelName,
      versionRange,
      filePath,
      {
        className: "DefaultExecutionEngine",
        methodName: "executeStepWithRetry",
        kind: "Async",
      },
    ),
  ]);
}

function toolConfigs(versionRange: string): InstrumentationConfig[] {
  return toolChunks.map(({ filePath }) =>
    config(
      mastraChannels.toolExecute.channelName,
      versionRange,
      filePath,
      {
        expressionName: "execute",
        kind: "Async",
      },
      mastraAssignedAsyncTransformName,
    ),
  );
}

export const mastraConfigs: InstrumentationConfig[] = [
  ...agentWorkflowConfigs(stableVersionRange, stableAgentWorkflowChunks),
  ...agentWorkflowConfigs(alphaVersionRange, alphaAgentWorkflowChunks),
  ...toolConfigs(stableVersionRange),
  ...toolConfigs(alphaVersionRange),
];
