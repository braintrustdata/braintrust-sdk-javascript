import { debugLogger } from "../../debug-logger";
import { isObject } from "../../util";
import { stagehandChannels } from "./stagehand-channels";
import type { StagehandAgent } from "../../vendor-sdk-types/stagehand";

const instrumentedAgents = new WeakSet<object>();

/** Instruments the mutable object returned by Stagehand.agent(). */
export function instrumentStagehandAgent(
  value: unknown,
  agentConfig: unknown,
  stagehand: unknown,
): unknown {
  if (!isObject(value) || instrumentedAgents.has(value)) {
    return value;
  }

  let execute: unknown;
  try {
    execute = value.execute;
  } catch (error) {
    debugLogger.error("Error reading Stagehand agent execute method:", error);
    return value;
  }
  if (typeof execute !== "function") {
    return value;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, "execute");
  const wrappedExecute = function (
    this: StagehandAgent,
    ...args: unknown[]
  ): Promise<unknown> {
    return stagehandChannels.agentExecute.tracePromise(
      () => Reflect.apply(execute, value, args),
      {
        agentConfig,
        arguments: args,
        self: value,
        stagehand,
      },
    ) as Promise<unknown>;
  };

  try {
    Object.defineProperty(value, "execute", {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      value: wrappedExecute,
      writable: descriptor?.writable ?? true,
    });
    instrumentedAgents.add(value);
  } catch (error) {
    debugLogger.error(
      "Error instrumenting Stagehand agent execute method:",
      error,
    );
  }

  return value;
}
