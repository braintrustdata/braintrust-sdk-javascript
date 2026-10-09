// LiveKit's native OTel payloads are JSON values, not OpenAI message objects.
// Normalize just the conversational surface; audio bytes are handled by capture.
import { isObject } from "../../../util";

export function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
export function operation(name: string): string {
  switch (name) {
    case "user_turn":
      return "user_turn";
    case "agent_turn":
      return "assistant_turn";
    case "llm_node":
    case "realtime_inference":
      return "llm_response";
    case "tts_node":
      return "tts";
    default:
      return `livekit.${name}`;
  }
}
export function isContentKey(key: string): boolean {
  return (
    key.includes(".pii.") ||
    /^gen_ai\.(input\.|output\.|system_instructions|tool\.(definitions|call\.(arguments|result)|description))/.test(
      key,
    )
  );
}

export type Message = {
  role: string;
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};
function stringify(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (!isObject(value)) return "";
  if (value.type === "text")
    return typeof value.content === "string"
      ? value.content
      : typeof value.text === "string"
        ? value.text
        : "";
  // Do not serialize inline image/audio frames into text or metadata.
  return typeof value.transcript === "string" ? value.transcript : "";
}
export function messages(value: unknown): Message[] | undefined {
  const parsed = parse(value);
  const items = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : undefined;
  if (!items) return;
  const result: Message[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    if (item.type === "function_call") {
      const id = item.call_id ?? item.callId;
      if (typeof id === "string" && typeof item.name === "string")
        result.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: item.name,
                arguments: stringify(item.arguments ?? item.args),
              },
            },
          ],
        });
    } else if (item.type === "function_call_output") {
      const id = item.call_id ?? item.callId;
      if (typeof id === "string")
        result.push({
          role: "tool",
          content: stringify(item.output),
          tool_call_id: id,
        });
    } else if (typeof item.role === "string") {
      const parts = Array.isArray(item.parts) ? item.parts : [];
      const message: Message = {
        role: item.role,
        content: text(item.content ?? parts) || null,
      };
      for (const part of parts) {
        if (!isObject(part)) continue;
        if (
          part.type === "tool_call" &&
          typeof part.id === "string" &&
          typeof part.name === "string"
        ) {
          (message.tool_calls ??= []).push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: stringify(part.arguments) },
          });
        } else if (
          part.type === "tool_call_response" &&
          typeof part.id === "string"
        ) {
          message.tool_call_id = part.id;
          message.content = stringify(part.response);
        }
      }
      result.push(message);
    }
  }
  return result;
}

export function modelFields(attrs: Record<string, unknown>) {
  const metrics: Record<string, number> = {};
  for (const [target, sources] of Object.entries({
    prompt_tokens: ["gen_ai.usage.input_tokens"],
    completion_tokens: ["gen_ai.usage.output_tokens"],
    cache_read_input_tokens: [
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.input_cached_tokens",
    ],
    cache_creation_input_tokens: ["gen_ai.usage.cache_write.input_tokens"],
    reasoning_tokens: [
      "gen_ai.usage.reasoning.output_tokens",
      "gen_ai.usage.reasoning_tokens",
    ],
    time_to_first_token: [
      "contrib.livekit.response.ttft",
      "gen_ai.response.time_to_first_chunk",
    ],
  })) {
    const value = sources
      .map((key) => attrs[key])
      .find(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0,
      );
    if (typeof value === "number") metrics[target] = value;
  }
  if (
    metrics.prompt_tokens !== undefined &&
    metrics.completion_tokens !== undefined
  )
    metrics.tokens = metrics.prompt_tokens + metrics.completion_tokens;
  const metadata: Record<string, string> = {};
  const model = attrs["gen_ai.response.model"] ?? attrs["gen_ai.request.model"];
  const provider = attrs["gen_ai.provider.name"];
  if (typeof model === "string") metadata.model = model;
  if (typeof provider === "string") metadata.provider = provider;
  return { metrics, metadata };
}
