import { isObject } from "../../../util";
import type { AISDKMessage } from "../../vendor-sdk-types/ai-sdk-common";
import type {
  AISDKBatchItem,
  AISDKBatchRequest,
} from "../../vendor-sdk-types/ai-sdk-batch";
import { serializeAISDKToolsForLogging } from "../../wrappers/ai-sdk/tool-serialization";
import {
  processAISDKCallInput,
  processAISDKOutput,
} from "./ai-sdk-instrumentation";

/** Translate AI SDK content into the completion format understood by the UI. */
function batchMessages(messages: AISDKMessage[]): Record<string, unknown>[] {
  return messages.flatMap((message): Record<string, unknown>[] => {
    if (typeof message.content === "string") {
      return [{ role: message.role, content: message.content }];
    }
    const content: unknown[] = [];
    const toolCalls: unknown[] = [];
    const toolResults: Record<string, unknown>[] = [];
    const reasoning: string[] = [];
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (!isObject(part)) continue;
      switch (part.type) {
        case "text":
          content.push({ type: "text", text: part.text });
          break;
        case "image":
          if (part.image !== undefined)
            content.push({ type: "image_url", image_url: { url: part.image } });
          break;
        case "file":
          if (part.data !== undefined)
            content.push({
              type: "file",
              file: { file_data: part.data, filename: part.filename },
            });
          break;
        case "reasoning":
          if (typeof part.text === "string") reasoning.push(part.text);
          break;
        case "tool-call":
          toolCalls.push({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.toolName,
              arguments:
                typeof part.input === "string"
                  ? part.input
                  : JSON.stringify(part.input ?? {}),
            },
          });
          break;
        case "tool-result": {
          const output =
            isObject(part.output) && "value" in part.output
              ? part.output.value
              : part.output;
          toolResults.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content:
              typeof output === "string" ? output : JSON.stringify(output),
          });
          break;
        }
      }
    }
    if (message.role === "tool") return toolResults;
    return [
      {
        role: message.role,
        content: content.length ? content : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(reasoning.length ? { reasoning: reasoning.join("") } : {}),
      },
      ...toolResults,
    ];
  });
}

export async function aiSDKBatchInput(request: AISDKBatchRequest): Promise<{
  input: Record<string, unknown>[];
  metadata: Record<string, unknown>;
}> {
  const processed = processAISDKCallInput({
    model: request.model,
    prompt: request.prompt,
    messages: request.messages,
    instructions: request.instructions,
    system: request.system,
    output: request.output,
  });
  const params = processed.input;
  const instructions = params.instructions ?? params.system;
  const messages: AISDKMessage[] =
    typeof instructions === "string"
      ? [{ role: "system", content: instructions }]
      : Array.isArray(instructions)
        ? instructions
        : [];
  if (typeof params.prompt === "string")
    messages.push({ role: "user", content: params.prompt });
  else if (Array.isArray(params.prompt)) messages.push(...params.prompt);
  else if (params.messages) messages.push(...params.messages);
  const metadata: Record<string, unknown> = {};
  // Explicit allowlist of generation settings. Provider options and transport
  // fields must never be copied onto a span.
  for (const [source, destination] of [
    ["temperature", "temperature"],
    ["topP", "top_p"],
    ["topK", "top_k"],
    ["maxOutputTokens", "max_tokens"],
    ["seed", "seed"],
    ["frequencyPenalty", "frequency_penalty"],
    ["presencePenalty", "presence_penalty"],
    ["stopSequences", "stop"],
    ["reasoning", "reasoning"],
  ]) {
    if (request[source] !== undefined) metadata[destination] = request[source];
  }
  const output = processed.outputPromise
    ? (await processed.outputPromise).output
    : params.output;
  if (isObject(output) && output.response_format !== undefined)
    metadata.response_format = output.response_format;
  if (request.tools) {
    // Serialize individually so a tool named "__proto__" remains an own entry.
    const tools = Object.entries(request.tools).map(([name, tool]) => {
      const serialized = serializeAISDKToolsForLogging([tool]);
      const definition = Array.isArray(serialized) ? serialized[0] : undefined;
      return {
        type: "function",
        function: {
          name,
          description: definition?.description,
          parameters: definition?.inputSchema ?? definition?.parameters,
          ...(typeof definition?.strict === "boolean"
            ? { strict: definition.strict }
            : {}),
        },
      };
    });
    if (tools.length) metadata.tools = tools;
  }
  if (request.toolChoice !== undefined) {
    metadata.tool_choice =
      isObject(request.toolChoice) && request.toolChoice.type === "tool"
        ? { type: "function", function: { name: request.toolChoice.toolName } }
        : request.toolChoice;
  }
  return { input: batchMessages(messages), metadata };
}

export function aiSDKBatchOutput(
  item: AISDKBatchItem,
  denyOutputPaths: string[],
): unknown {
  const output = processAISDKOutput(
    {
      text: item.text,
      content: item.content,
      finishReason: item.finishReason,
    },
    denyOutputPaths,
  );
  const message = batchMessages([
    {
      role: "assistant",
      content: Array.isArray(output.content) ? output.content : output.text,
    },
  ])[0];
  return [
    {
      index: 0,
      finish_reason:
        output.finishReason === "tool-calls"
          ? "tool_calls"
          : output.finishReason,
      message,
    },
  ];
}
