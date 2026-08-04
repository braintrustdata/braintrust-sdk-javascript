import { debugLogger } from "../../debug-logger";
import { isObject } from "../../util";
import { stagehandChannels } from "./stagehand-channels";
import type {
  StagehandAgent,
  StagehandAgentConfig,
  StagehandAgentExecuteArguments,
  StagehandInstance,
} from "../../vendor-sdk-types/stagehand";

const instrumentedAgents = new WeakSet<object>();

/** Instruments the mutable object returned by Stagehand.agent(). */
export function instrumentStagehandAgent(
  value: unknown,
  agentConfig: StagehandAgentConfig | undefined,
  stagehand: StagehandInstance | undefined,
): unknown {
  if (!isObject(value) || instrumentedAgents.has(value)) {
    return value;
  }

  const agent = value as StagehandAgent;
  let descriptor: PropertyDescriptor | undefined;
  let execute: unknown;
  try {
    execute = agent.execute;
    descriptor = Object.getOwnPropertyDescriptor(agent, "execute");
  } catch (error) {
    debugLogger.error(
      "Error inspecting Stagehand agent execute method:",
      error,
    );
    return value;
  }
  if (typeof execute !== "function") {
    return value;
  }

  const wrappedExecute = function (
    ...args: StagehandAgentExecuteArguments
  ): ReturnType<StagehandAgent["execute"]> {
    return stagehandChannels.agentExecute.tracePromise(
      () => Reflect.apply(execute, agent, args),
      {
        agentConfig,
        arguments: args,
        self: agent,
        stagehand,
      },
    );
  };

  try {
    Object.defineProperty(agent, "execute", {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      value: wrappedExecute,
      writable: descriptor?.writable ?? true,
    });
    instrumentedAgents.add(agent);
  } catch (error) {
    debugLogger.error(
      "Error instrumenting Stagehand agent execute method:",
      error,
    );
  }

  return value;
}
