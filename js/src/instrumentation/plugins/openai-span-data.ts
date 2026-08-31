/* eslint-disable @typescript-eslint/no-explicit-any */
import { Attachment } from "../../logger";
import { processInputAttachments } from "../../wrappers/attachment-utils";
import { isObject } from "../../../util/index";

const OPENAI_METADATA_KEYS = [
  "model",
  "temperature",
  "top_p",
  "max_tokens",
  "frequency_penalty",
  "presence_penalty",
  "stop",
  "response_format",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "max_tool_calls",
] as const;

function batchMetadata(params: Record<string, unknown>) {
  const metadata: Record<string, unknown> = { provider: "openai" };
  for (const key of OPENAI_METADATA_KEYS) {
    try {
      const value = Reflect.get(params, key);
      if (value !== undefined) {
        metadata[key] = value;
      }
    } catch {
      // Ignore hostile getters in provider input.
    }
  }
  return metadata;
}

export function extractOpenAIBatchInput(
  endpoint: string,
  params: Record<string, unknown>,
): { input: unknown; metadata: Record<string, unknown> } {
  const input =
    endpoint === "/v1/chat/completions" ? params.messages : params.input;
  return {
    input: processInputAttachments(input),
    metadata: batchMetadata(params),
  };
}

export function extractOpenAIChatInput(params: Record<string, unknown>): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const { messages, ...metadata } = params;
  return {
    input: processInputAttachments(messages),
    metadata: { ...metadata, provider: "openai" },
  };
}

export function extractOpenAIResponsesInput(params: Record<string, unknown>): {
  input: unknown;
  metadata: Record<string, unknown>;
} {
  const { input, ...metadata } = params;
  return {
    input: processInputAttachments(input),
    metadata: { ...metadata, provider: "openai" },
  };
}

export function extractOpenAIResponsesMetadata(
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!result) {
    return undefined;
  }
  const { output: _output, usage: _usage, ...metadata } = result;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Convert Responses API base64 image outputs to Braintrust attachments. */
export function processImagesInOutput(output: any): any {
  if (Array.isArray(output)) {
    return output.map(processImagesInOutput);
  }

  if (
    isObject(output) &&
    output.type === "image_generation_call" &&
    typeof output.result === "string" &&
    output.result
  ) {
    const fileExtension = output.output_format || "png";
    const contentType = `image/${fileExtension}`;
    const baseFilename =
      typeof output.revised_prompt === "string"
        ? output.revised_prompt.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "_")
        : "generated_image";
    let binaryString: string;
    try {
      binaryString = atob(output.result);
    } catch {
      return output;
    }
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return {
      ...output,
      result: new Attachment({
        data: new Blob([bytes], { type: contentType }),
        filename: `${baseFilename}.${fileExtension}`,
        contentType,
      }),
    };
  }

  return output;
}
