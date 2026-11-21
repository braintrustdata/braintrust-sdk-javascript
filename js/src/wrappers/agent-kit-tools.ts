import { isObject } from "../../util";
import { agentKitChannels } from "../instrumentation/providers/agent-kit-interceptors";

const handlers = new WeakMap<object, unknown>();

/** Wrap invocation mechanics while retaining the tool object and receiver. */
export function wrapAgentKitTool<T>(tool: T): T {
  if (!isObject(tool)) return tool;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(tool, "handler");
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    )
      return tool;
    const original = descriptor.value;
    if (
      handlers.get(tool) === original ||
      (!descriptor.writable && !descriptor.configurable)
    )
      return tool;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      let toolName: string | undefined;
      try {
        const name = tool.name;
        if (typeof name === "string") toolName = name;
      } catch {
        // Metadata access must not prevent the user's handler from running.
      }
      return agentKitChannels.tool.invoke(
        (...parameters: unknown[]) => Reflect.apply(original, this, parameters),
        this,
        args,
        { toolName },
      );
    };
    Object.defineProperty(tool, "handler", { ...descriptor, value: wrapped });
    handlers.set(tool, wrapped);
  } catch {
    // Immutable or unusual tool objects must keep their original behavior.
  }
  return tool;
}

/** Include plain, Inngest-function and MCP tools populated by the SDK. */
export function prepareAgentKitTools(agent: unknown): void {
  if (!isObject(agent) || !(agent.tools instanceof Map)) return;
  for (const tool of agent.tools.values()) wrapAgentKitTool(tool);
}
