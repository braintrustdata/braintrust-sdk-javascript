import { startSpan, withCurrent } from "../../logger";
import { SpanTypeAttribute } from "../../../util/index";

export type LocalToolSpanMetadata = {
  serverName?: string;
  toolName: string;
};

type LocalToolHandler = (...args: unknown[]) => unknown;

const LOCAL_TOOL_HANDLER_WRAPPED = Symbol.for(
  "braintrust.claude_agent_sdk.local_tool_handler_wrapped",
);

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function wrapLocalClaudeToolHandler(
  handler: LocalToolHandler,
  getMetadata: () => LocalToolSpanMetadata,
): LocalToolHandler {
  if (
    (handler as LocalToolHandler & { [LOCAL_TOOL_HANDLER_WRAPPED]?: boolean })[
      LOCAL_TOOL_HANDLER_WRAPPED
    ]
  ) {
    return handler;
  }

  const wrappedHandler: LocalToolHandler = function wrappedLocalToolHandler(
    this: unknown,
    ...handlerArgs: unknown[]
  ) {
    const metadata = getMetadata();
    const spanName = metadata.serverName
      ? `tool: ${metadata.serverName}/${metadata.toolName}`
      : `tool: ${metadata.toolName}`;
    const span = startSpan({
      event: {
        input: handlerArgs[0],
        metadata: {
          "gen_ai.tool.name": metadata.toolName,
          ...(metadata.serverName && {
            "mcp.server": metadata.serverName,
          }),
        },
      },
      name: spanName,
      spanAttributes: { type: SpanTypeAttribute.TOOL },
    });

    const runHandler = () => Reflect.apply(handler, this, handlerArgs);
    const finalizeSuccess = (result: unknown) => {
      span.log({ output: result });
      span.end();
      return result;
    };
    const finalizeError = (error: unknown) => {
      span.log({ error: toErrorMessage(error) });
      span.end();
      throw error;
    };

    return withCurrent(span, () => {
      try {
        const result = runHandler();
        if (isPromiseLike(result)) {
          return result.then(finalizeSuccess, finalizeError);
        }
        return finalizeSuccess(result);
      } catch (error) {
        return finalizeError(error);
      }
    });
  };

  Object.defineProperty(wrappedHandler, LOCAL_TOOL_HANDLER_WRAPPED, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  return wrappedHandler;
}

type LocalToolRegistration = {
  [key: string]: unknown;
  handler?: unknown;
};

function getRegisteredTools(
  instance: unknown,
):
  | Map<string, LocalToolRegistration>
  | Record<string, LocalToolRegistration>
  | undefined {
  if (!instance || typeof instance !== "object") {
    return undefined;
  }

  if (!("_registeredTools" in instance)) {
    return undefined;
  }

  const registeredTools = Reflect.get(instance, "_registeredTools");
  if (registeredTools instanceof Map) {
    return registeredTools as Map<string, LocalToolRegistration>;
  }

  if (registeredTools && typeof registeredTools === "object") {
    return registeredTools as Record<string, LocalToolRegistration>;
  }

  return undefined;
}

export function wrapLocalMcpServerToolHandlers(
  serverName: string,
  serverConfig: unknown,
): boolean {
  if (!serverConfig || typeof serverConfig !== "object") {
    return false;
  }

  if (!("instance" in serverConfig)) {
    return false;
  }

  const instance = Reflect.get(serverConfig, "instance");
  const registeredTools = getRegisteredTools(instance);
  if (!registeredTools) {
    return false;
  }

  let wrappedAny = false;
  const wrapHandler = (toolName: string, registration: unknown) => {
    if (!registration || typeof registration !== "object") {
      return;
    }

    const handler = Reflect.get(registration, "handler");
    if (typeof handler !== "function") {
      return;
    }

    const wrappedHandler = wrapLocalClaudeToolHandler(handler, () => ({
      serverName,
      toolName,
    }));
    if (wrappedHandler !== handler) {
      Reflect.set(registration, "handler", wrappedHandler);
      wrappedAny = true;
    }
  };

  if (registeredTools instanceof Map) {
    for (const [toolName, registration] of registeredTools.entries()) {
      wrapHandler(toolName, registration);
    }
    return wrappedAny;
  }

  for (const [toolName, registration] of Object.entries(registeredTools)) {
    wrapHandler(toolName, registration);
  }

  return wrappedAny;
}

export function collectLocalMcpServerToolHookNames(
  serverName: string,
  serverConfig: unknown,
): Set<string> {
  const toolNames = new Set<string>();

  if (!serverConfig || typeof serverConfig !== "object") {
    return toolNames;
  }

  if ("instance" in serverConfig) {
    const instance = Reflect.get(serverConfig, "instance");
    const registeredTools = getRegisteredTools(instance);
    if (registeredTools instanceof Map) {
      for (const toolName of registeredTools.keys()) {
        toolNames.add(toolName);
        toolNames.add(`mcp__${serverName}__${toolName}`);
      }
    } else if (registeredTools) {
      for (const toolName of Object.keys(registeredTools)) {
        toolNames.add(toolName);
        toolNames.add(`mcp__${serverName}__${toolName}`);
      }
    }
  }

  if ("tools" in serverConfig) {
    const rawTools = Reflect.get(serverConfig, "tools");
    if (Array.isArray(rawTools)) {
      for (const tool of rawTools) {
        if (!tool || typeof tool !== "object") {
          continue;
        }
        const toolName = Reflect.get(tool, "name");
        if (typeof toolName !== "string") {
          continue;
        }
        toolNames.add(toolName);
        toolNames.add(`mcp__${serverName}__${toolName}`);
      }
    }
  }

  return toolNames;
}
