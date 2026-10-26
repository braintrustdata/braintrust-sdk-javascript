import { isObject, isObjectOrArray } from "../../util";

type AISDKToolWithModelOutput = {
  toModelOutput: (...args: unknown[]) => unknown;
};

export function hasAISDKToolModelOutput(
  tool: unknown,
): tool is AISDKToolWithModelOutput {
  return isObject(tool) && typeof tool.toModelOutput === "function";
}

export function aiSDKModelOutputToolNames(...toolSets: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const tools of toolSets) {
    if (!isObjectOrArray(tools)) {
      continue;
    }
    // AI SDK names array tools by index, so their keys match tool results.
    for (const [name, tool] of Object.entries(tools)) {
      if (hasAISDKToolModelOutput(tool)) {
        names.add(name);
      }
    }
  }
  return names;
}

function isToolResultFor(
  value: Record<string, unknown>,
  toolNames: Set<string>,
): value is Record<string, unknown> & { toolCallId: string } {
  return (
    value.type === "tool-result" &&
    typeof value.toolName === "string" &&
    toolNames.has(value.toolName) &&
    typeof value.toolCallId === "string"
  );
}

/** Collect the model-facing results that AI SDK tool messages carry. */
export function collectAISDKToolModelOutputs(
  output: unknown,
  toolNames: Set<string>,
): Map<string, unknown> {
  const modelOutputs = new Map<string, unknown>();
  if (toolNames.size === 0) {
    return modelOutputs;
  }
  const seen = new WeakSet<object>();
  const collect = (value: unknown, inToolMessage: boolean): void => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => collect(entry, inToolMessage));
    } else if (isObject(value)) {
      if (inToolMessage && isToolResultFor(value, toolNames)) {
        modelOutputs.set(value.toolCallId, value.output);
        return;
      }
      const isToolMessage = inToolMessage || value.role === "tool";
      Object.values(value).forEach((entry) => collect(entry, isToolMessage));
    }
  };
  collect(output, false);
  return modelOutputs;
}

/**
 * Replace raw results of tools that define `toModelOutput` with what the model
 * saw. AI SDK tool messages already carry that value, so it is reused instead
 * of invoking user code again. Results without a matching tool message drop
 * their output rather than log the raw value.
 */
export function applyAISDKToolModelOutputs<T>(
  output: T,
  toolNames: Set<string>,
): T {
  if (toolNames.size === 0 || !isObject(output)) {
    return output;
  }

  const modelOutputs = collectAISDKToolModelOutputs(output, toolNames);

  // Copy only the containers on the path to a replaced result.
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const entries = value.map(replace);
      return entries.some((entry, index) => entry !== value[index])
        ? entries
        : value;
    }
    if (!isPlainObject(value)) {
      return value;
    }
    if (isToolResultFor(value, toolNames)) {
      const { output: _rawOutput, ...rest } = value;
      return modelOutputs.has(value.toolCallId)
        ? { ...rest, output: modelOutputs.get(value.toolCallId) }
        : rest;
    }
    let replaced: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const next = replace(entry);
      if (next !== entry) {
        replaced ??= { ...value };
        replaced[key] = next;
      }
    }
    return replaced ?? value;
  };
  return replace(output) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
