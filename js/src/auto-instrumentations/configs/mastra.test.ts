import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { mastraChannels } from "../../instrumentation/plugins/mastra-channels";
import {
  createEventCollector,
  runAndCollectEvents,
} from "../../../tests/auto-instrumentations/test-helpers";
import { createInstrumentationMatcher } from "../custom-transforms";
import { mastraConfigs } from "./mastra";

const require = createRequire(import.meta.url);

function configsForChannel(channelName: string) {
  return mastraConfigs.filter((config) => config.channelName === channelName);
}

function transformWithConfig(options: {
  channelName: string;
  code: string;
  filePath: string;
  moduleType: "esm" | "cjs";
  version?: string;
}) {
  const config = mastraConfigs.find(
    (candidate) =>
      candidate.channelName === options.channelName &&
      candidate.module.filePath === options.filePath,
  );
  expect(config).toBeDefined();

  const matcher = createInstrumentationMatcher([config!]);
  const transformer = matcher.getTransformer(
    "@mastra/core",
    options.version ?? "1.26.0",
    options.filePath,
  );
  expect(transformer).toBeDefined();

  return transformer!.transform(options.code, options.moduleType).code;
}

describe("mastraConfigs", () => {
  it("defines expected Mastra channels", () => {
    expect(mastraChannels.agentExecute.channelName).toBe("agent.execute");
    expect(mastraChannels.agentNetwork.channelName).toBe("agent.network");
    expect(mastraChannels.agentGenerateLegacy.channelName).toBe(
      "agent.generateLegacy",
    );
    expect(mastraChannels.agentStreamLegacy.channelName).toBe(
      "agent.streamLegacy",
    );
    expect(mastraChannels.toolExecute.channelName).toBe("tool.execute");
    expect(mastraChannels.workflowRunStart.channelName).toBe(
      "workflow.run.start",
    );
    expect(mastraChannels.workflowRunResume.channelName).toBe(
      "workflow.run.resume",
    );
    expect(mastraChannels.workflowRunRestart.channelName).toBe(
      "workflow.run.restart",
    );
    expect(mastraChannels.workflowStepExecute.channelName).toBe(
      "workflow.step.execute",
    );
  });

  it("instruments current stable and alpha Mastra chunks", () => {
    expect(
      configsForChannel(mastraChannels.agentExecute.channelName).map(
        (config) => config.module.filePath,
      ),
    ).toEqual(
      expect.arrayContaining([
        "dist/chunk-CXW3Z2OL.js",
        "dist/chunk-PBGNXXU5.cjs",
        "dist/chunk-4QTY73BW.js",
        "dist/chunk-7432OHPH.cjs",
      ]),
    );

    expect(
      configsForChannel(mastraChannels.toolExecute.channelName).map(
        (config) => config.module.filePath,
      ),
    ).toEqual(
      expect.arrayContaining([
        "dist/chunk-O3JJ5ZPY.js",
        "dist/chunk-U7Z7GCXY.cjs",
      ]),
    );
  });

  it("transforms constructor-assigned Tool.execute", async () => {
    const output = transformWithConfig({
      channelName: mastraChannels.toolExecute.channelName,
      filePath: "dist/chunk-O3JJ5ZPY.js",
      moduleType: "cjs",
      code: `
        var Tool = class {
          execute;
          constructor(opts) {
            if (opts.execute) {
              this.execute = async (inputData, context) => {
                return await opts.execute(inputData, context);
              };
            }
          }
        };
      `,
    });

    expect(output).toContain("orchestrion:@mastra/core:tool.execute");
    expect(output).toContain("tr_ch_apm$tool_execute.asyncEnd.publish");
    expect(output).toContain("this.execute = function (inputData, context)");

    const collector = createEventCollector();
    collector.subscribe("orchestrion:@mastra/core:tool.execute");

    const Tool = new Function("require", `${output}; return Tool;`)(
      require,
    ) as new (opts: {
      execute: (
        inputData: unknown,
        context: unknown,
      ) => Promise<{ forecast: string }>;
    }) => {
      execute: (inputData: unknown, context: unknown) => Promise<unknown>;
    };

    const tool = new Tool({
      execute: async (_inputData, context) => {
        expect(context).toEqual({
          workflow: {
            workflowId: "travel-flow",
            runId: "workflow-run",
          },
        });
        return { forecast: "Sunny" };
      },
    });

    await runAndCollectEvents(
      () =>
        tool.execute(
          { city: "Paris" },
          {
            workflow: {
              workflowId: "travel-flow",
              runId: "workflow-run",
            },
          },
        ),
      collector,
    );

    expect(collector.start[0]?.arguments).toEqual([
      { city: "Paris" },
      {
        workflow: {
          workflowId: "travel-flow",
          runId: "workflow-run",
        },
      },
    ]);
  });

  it("transforms Agent.#execute", () => {
    const output = transformWithConfig({
      channelName: mastraChannels.agentExecute.channelName,
      filePath: "dist/chunk-CXW3Z2OL.js",
      moduleType: "esm",
      code: `
        var Agent = class _Agent {
          async #execute(options) {
            return { status: "success", result: options };
          }
          async generate(messages, options) {
            return this.#execute({ ...options, messages, methodType: "generate" });
          }
        };
      `,
    });

    expect(output).toContain("orchestrion:@mastra/core:agent.execute");
  });
});
