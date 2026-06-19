import { isObject } from "../../../util/index";
import type {
  BedrockRuntimeCommandLike,
  BedrockRuntimeCommandName,
} from "../../vendor-sdk-types/bedrock-runtime";

export type BedrockRuntimeOperation =
  | "converse"
  | "converseStream"
  | "invokeModel"
  | "invokeModelWithResponseStream";

const BEDROCK_RUNTIME_COMMAND_OPERATIONS: Record<
  BedrockRuntimeCommandName,
  BedrockRuntimeOperation
> = {
  ConverseCommand: "converse",
  ConverseStreamCommand: "converseStream",
  InvokeModelCommand: "invokeModel",
  InvokeModelWithResponseStreamCommand: "invokeModelWithResponseStream",
};

export function getBedrockRuntimeCommandName(
  command: unknown,
): BedrockRuntimeCommandName | undefined {
  if (!isObject(command) || !isObject(command.constructor)) {
    return undefined;
  }

  const input = (command as BedrockRuntimeCommandLike).input;
  if (!isObject(input) || typeof input.modelId !== "string") {
    return undefined;
  }

  const commandName = command.constructor.name;
  return isBedrockRuntimeCommandName(commandName) ? commandName : undefined;
}

export function getBedrockRuntimeOperation(
  command: unknown,
): BedrockRuntimeOperation | undefined {
  const commandName = getBedrockRuntimeCommandName(command);
  return commandName
    ? BEDROCK_RUNTIME_COMMAND_OPERATIONS[commandName]
    : undefined;
}

export function getBedrockRuntimeCommandInput(
  command: unknown,
): unknown | undefined {
  return isObject(command)
    ? (command as BedrockRuntimeCommandLike).input
    : undefined;
}

export function buildBedrockRuntimeSpanInfo(command: unknown): {
  name: string;
  metadata: Record<string, unknown>;
} {
  const commandName = getBedrockRuntimeCommandName(command);
  const operation = getBedrockRuntimeOperation(command);

  return {
    name: operation ? `bedrock.${operation}` : "bedrock.client.send",
    metadata: {
      ...(commandName ? { command: commandName } : {}),
      ...(operation ? { operation } : {}),
    },
  };
}

function isBedrockRuntimeCommandName(
  commandName: unknown,
): commandName is BedrockRuntimeCommandName {
  return (
    commandName === "ConverseCommand" ||
    commandName === "ConverseStreamCommand" ||
    commandName === "InvokeModelCommand" ||
    commandName === "InvokeModelWithResponseStreamCommand"
  );
}
