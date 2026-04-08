import { claudeAgentSDKChannels } from "../../instrumentation/plugins/claude-agent-sdk-channels";
import { CLAUDE_AGENT_SDK_SKIP_LOCAL_TOOL_HOOKS_OPTION } from "../../instrumentation/plugins/claude-agent-sdk-instrumentation-constants";
import { wrapLocalClaudeToolHandler } from "../../instrumentation/plugins/claude-agent-sdk-local-tool-spans";
import type {
  ClaudeAgentSDKModule,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";

type LocalToolMetadata = {
  serverName?: string;
  toolName: string;
};

/**
 * Wraps the Claude Agent SDK with Braintrust tracing. Query calls only publish
 * tracing-channel events; the Claude Agent SDK plugin owns all span lifecycle
 * work, including root/task spans, LLM spans, tool spans, and sub-agent spans.
 *
 * @param sdk - The Claude Agent SDK module
 * @returns Object with wrapped query, tool, and createSdkMcpServer functions
 */
export function wrapClaudeAgentSDK<T extends object>(sdk: T): T {
  const s: unknown = sdk;
  if (
    s &&
    typeof s === "object" &&
    "query" in s &&
    typeof s.query === "function"
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return claudeAgentSDKProxy(s as ClaudeAgentSDKModule) as unknown as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported Claude Agent SDK. Not wrapping.");
  return sdk;
}

function wrapClaudeAgentQuery(
  queryFn: ClaudeAgentSDKModule["query"],
  defaultThis?: unknown,
): ClaudeAgentSDKModule["query"] {
  const proxy = new Proxy(queryFn, {
    apply(target, thisArg, argArray) {
      const params = (argArray[0] ?? {}) as ClaudeAgentSDKQueryParams;
      const wrappedParams: ClaudeAgentSDKQueryParams = {
        ...params,
        options: {
          ...(params.options ?? {}),
          [CLAUDE_AGENT_SDK_SKIP_LOCAL_TOOL_HOOKS_OPTION]: true,
        },
      };
      const invocationTarget: unknown =
        thisArg === proxy || thisArg === undefined
          ? (defaultThis ?? thisArg)
          : thisArg;
      return claudeAgentSDKChannels.query.traceSync(
        () => Reflect.apply(target, invocationTarget, [wrappedParams]),
        // The channel carries no extra context fields, but the generated
        // StartOf<> type for Record<string, never> is overly strict here.
        { arguments: [wrappedParams] } as never,
      );
    },
  });

  return proxy;
}

function wrapClaudeAgentTool(
  toolFn: ClaudeAgentSDKModule["tool"],
  localToolMetadataByTool: WeakMap<object, LocalToolMetadata>,
  defaultThis?: unknown,
): ClaudeAgentSDKModule["tool"] {
  const proxy = new Proxy(toolFn, {
    apply(target, thisArg, argArray) {
      const invocationTarget: unknown =
        thisArg === proxy || thisArg === undefined
          ? (defaultThis ?? thisArg)
          : thisArg;
      const wrappedArgs = [...argArray];

      const toolName = wrappedArgs[0];
      let handlerIndex = -1;
      for (let i = wrappedArgs.length - 1; i >= 0; i -= 1) {
        if (typeof wrappedArgs[i] === "function") {
          handlerIndex = i;
          break;
        }
      }
      if (typeof toolName !== "string" || handlerIndex === -1) {
        return Reflect.apply(target, invocationTarget, wrappedArgs);
      }

      const localToolMetadata: LocalToolMetadata = { toolName };
      const originalHandler = wrappedArgs[handlerIndex] as (
        ...args: unknown[]
      ) => unknown;
      wrappedArgs[handlerIndex] = wrapLocalClaudeToolHandler(
        originalHandler,
        () => localToolMetadata,
      );

      const wrappedTool = Reflect.apply(target, invocationTarget, wrappedArgs);
      if (wrappedTool && typeof wrappedTool === "object") {
        localToolMetadataByTool.set(wrappedTool, localToolMetadata);
      }

      return wrappedTool;
    },
  });

  return proxy;
}

function wrapCreateSdkMcpServer(
  createSdkMcpServerFn: (...args: unknown[]) => unknown,
  localToolMetadataByTool: WeakMap<object, LocalToolMetadata>,
  defaultThis?: unknown,
): (...args: unknown[]) => unknown {
  const proxy = new Proxy(createSdkMcpServerFn, {
    apply(target, thisArg, argArray) {
      const invocationTarget: unknown =
        thisArg === proxy || thisArg === undefined
          ? (defaultThis ?? thisArg)
          : thisArg;
      const config = argArray[0] as
        | { name?: unknown; tools?: unknown[] }
        | undefined;
      const serverName = config?.name;

      if (typeof serverName === "string" && Array.isArray(config?.tools)) {
        for (const tool of config.tools) {
          if (!tool || typeof tool !== "object") {
            continue;
          }

          const metadata = localToolMetadataByTool.get(tool);
          if (metadata) {
            metadata.serverName = serverName;
          }
        }
      }

      return Reflect.apply(target, invocationTarget, argArray);
    },
  });

  return proxy as (...args: unknown[]) => unknown;
}

function claudeAgentSDKProxy(sdk: ClaudeAgentSDKModule): ClaudeAgentSDKModule {
  const cache = new Map<PropertyKey, unknown>();
  const localToolMetadataByTool = new WeakMap<object, LocalToolMetadata>();

  return new Proxy(sdk, {
    get(target, prop, receiver) {
      if (cache.has(prop)) {
        return cache.get(prop);
      }

      const value = Reflect.get(target, prop, receiver);

      if (prop === "query" && typeof value === "function") {
        const wrappedQuery = wrapClaudeAgentQuery(target.query, target);
        cache.set(prop, wrappedQuery);
        return wrappedQuery;
      }

      if (prop === "tool" && typeof value === "function") {
        const wrappedTool = wrapClaudeAgentTool(
          target.tool,
          localToolMetadataByTool,
          target,
        );
        cache.set(prop, wrappedTool);
        return wrappedTool;
      }

      if (prop === "createSdkMcpServer" && typeof value === "function") {
        const wrappedCreateSdkMcpServer = wrapCreateSdkMcpServer(
          value as (...args: unknown[]) => unknown,
          localToolMetadataByTool,
          target,
        );
        cache.set(prop, wrappedCreateSdkMcpServer);
        return wrappedCreateSdkMcpServer;
      }

      if (typeof value === "function") {
        const bound = value.bind(target);
        cache.set(prop, bound);
        return bound;
      }

      return value;
    },
  });
}
