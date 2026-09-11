import { isObject } from "../../../util/index";
import type {
  BedrockAgentRuntimeCommandLike,
  BedrockAgentRuntimeCommandName,
} from "../../vendor-sdk-types/bedrock-agent-runtime";

export type BedrockAgentRuntimeOperation =
  | "invokeAgent"
  | "invokeInlineAgent"
  | "retrieveAndGenerate"
  | "retrieveAndGenerateStream";

const COMMAND_OPERATIONS: Record<
  BedrockAgentRuntimeCommandName,
  BedrockAgentRuntimeOperation
> = {
  InvokeAgentCommand: "invokeAgent",
  InvokeInlineAgentCommand: "invokeInlineAgent",
  RetrieveAndGenerateCommand: "retrieveAndGenerate",
  RetrieveAndGenerateStreamCommand: "retrieveAndGenerateStream",
};

export function getBedrockAgentRuntimeCommandName(
  command: unknown,
): BedrockAgentRuntimeCommandName | undefined {
  if (!isObject(command) || !isObject(command.constructor)) {
    return undefined;
  }

  const commandName = command.constructor.name;
  const input = (command as BedrockAgentRuntimeCommandLike).input;
  if (!isObject(input) || !isBedrockAgentRuntimeCommandName(commandName)) {
    return undefined;
  }

  if (
    commandName === "InvokeAgentCommand" &&
    (typeof input.agentId !== "string" ||
      typeof input.agentAliasId !== "string" ||
      typeof input.sessionId !== "string")
  ) {
    return undefined;
  }

  if (
    commandName === "InvokeInlineAgentCommand" &&
    (typeof input.foundationModel !== "string" ||
      typeof input.instruction !== "string" ||
      typeof input.sessionId !== "string")
  ) {
    return undefined;
  }

  if (
    (commandName === "RetrieveAndGenerateCommand" ||
      commandName === "RetrieveAndGenerateStreamCommand") &&
    (!isObject(input.input) || typeof input.input.text !== "string")
  ) {
    return undefined;
  }

  return commandName;
}

export function getBedrockAgentRuntimeOperation(
  command: unknown,
): BedrockAgentRuntimeOperation | undefined {
  const commandName = getBedrockAgentRuntimeCommandName(command);
  return commandName ? COMMAND_OPERATIONS[commandName] : undefined;
}

export function getBedrockAgentRuntimeCommandInput(
  command: unknown,
): unknown | undefined {
  return isObject(command)
    ? (command as BedrockAgentRuntimeCommandLike).input
    : undefined;
}

export function buildBedrockAgentRuntimeSpanInfo(command: unknown): {
  name: string;
  metadata: Record<string, unknown>;
} {
  const commandName = getBedrockAgentRuntimeCommandName(command);
  const operation = getBedrockAgentRuntimeOperation(command);

  return {
    name: operation ? `bedrockAgent.${operation}` : "bedrockAgent.client.send",
    metadata: {
      ...(commandName ? { command: commandName } : {}),
      ...(operation ? { operation } : {}),
    },
  };
}

function isBedrockAgentRuntimeCommandName(
  value: unknown,
): value is BedrockAgentRuntimeCommandName {
  return (
    value === "InvokeAgentCommand" ||
    value === "InvokeInlineAgentCommand" ||
    value === "RetrieveAndGenerateCommand" ||
    value === "RetrieveAndGenerateStreamCommand"
  );
}
