import { isObject } from "../../../util";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import {
  prepareAgentKitTools,
  wrapAgentKitTool,
} from "../../wrappers/agent-kit-tools";
import { runInstrumentation } from "../core/observe-result";
import { traceAsyncCall } from "../core/tracing";
import { agentKitChannels } from "./agent-kit-interceptors";

function nameOf(value: unknown): string | undefined {
  return isObject(value) && typeof value.name === "string"
    ? value.name
    : undefined;
}

function outputOf(result: unknown): unknown {
  if (!isObject(result)) return undefined;
  return Array.isArray(result.output) ? result.output : undefined;
}

export function registerAgentKitInstrumentation(): void {
  agentKitChannels.prepareTools.intercept((target, self, args) => {
    runInstrumentation(() => prepareAgentKitTools(self));
    return Reflect.apply(target, self, args);
  });
  agentKitChannels.createTool.intercept((target, self, args) =>
    wrapAgentKitTool(Reflect.apply(target, self, args)),
  );
  for (const [key, name] of [
    ["agentRun", "agent.run"],
    ["networkRun", "network.run"],
  ] as const) {
    const hook = agentKitChannels[key];
    hook.intercept((target, self, args, additional) =>
      traceAsyncCall<typeof hook>(
        () => Reflect.apply(target, self, args),
        { ...additional, arguments: args, self },
        {
          instrumentationName: INSTRUMENTATION_NAMES.AGENT_KIT,
          name: `agentkit.${name}`,
          type: "task",
          extractInput: ([input]) => ({
            input: isObject(input) ? input.content : input,
            metadata: {
              provider: "inngest",
              [key === "agentRun" ? "agent_name" : "network_name"]:
                nameOf(self),
            },
          }),
          extractOutput: (result) => {
            if (key === "agentRun") return outputOf(result);
            if (
              !isObject(result) ||
              !isObject(result.state) ||
              !Array.isArray(result.state.results)
            )
              return undefined;
            return outputOf(result.state.results.at(-1));
          },
          extractMetrics: () => ({}),
        },
      ),
    );
  }
  agentKitChannels.infer.intercept((target, self, args, additional) =>
    traceAsyncCall<typeof agentKitChannels.infer>(
      () => Reflect.apply(target, self, args),
      { ...additional, arguments: args, self },
      {
        instrumentationName: INSTRUMENTATION_NAMES.AGENT_KIT,
        name: "agentkit.model.infer",
        type: "llm",
        extractInput: ([stepId, input]) => ({
          input,
          metadata: { provider: "inngest", agent_name: stepId },
        }),
        extractOutput: outputOf,
        extractMetrics: (result) => {
          if (
            !isObject(result) ||
            !isObject(result.raw) ||
            !isObject(result.raw.usage)
          )
            return {};
          const usage = result.raw.usage;
          const metrics: Record<string, number> = {};
          for (const [source, destination] of [
            ["prompt_tokens", "prompt_tokens"],
            ["completion_tokens", "completion_tokens"],
            ["total_tokens", "tokens"],
          ] as const) {
            const value = usage[source];
            if (
              typeof value === "number" &&
              Number.isFinite(value) &&
              value >= 0
            )
              metrics[destination] = value;
          }
          return metrics;
        },
      },
    ),
  );
  agentKitChannels.route.intercept((target, self, args, additional) =>
    traceAsyncCall<typeof agentKitChannels.route>(
      () => Reflect.apply(target, self, args),
      { ...additional, arguments: args, self },
      {
        instrumentationName: INSTRUMENTATION_NAMES.AGENT_KIT,
        name: "agentkit.network.route",
        type: "task",
        extractInput: ([input]) => ({
          input: isObject(input) ? input.content : input,
          metadata: { provider: "inngest", network_name: nameOf(self) },
        }),
        extractOutput: (result) =>
          Array.isArray(result)
            ? result.map(nameOf).filter((name) => name !== undefined)
            : [],
        extractMetrics: () => ({}),
      },
    ),
  );
  agentKitChannels.tool.intercept((target, self, args, additional) =>
    traceAsyncCall<typeof agentKitChannels.tool>(
      () => Reflect.apply(target, self, args),
      { ...additional, arguments: args, self },
      {
        instrumentationName: INSTRUMENTATION_NAMES.AGENT_KIT,
        name: "agentkit.tool",
        type: "tool",
        extractInput: ([input]) => ({
          input,
          metadata: {
            provider: "inngest",
            tool_name: additional.toolName ?? nameOf(self),
          },
        }),
        extractOutput: (result) => result,
        extractMetrics: () => ({}),
      },
    ),
  );
}
