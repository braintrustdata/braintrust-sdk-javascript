import { claudeAgentSDKChannels } from "../../instrumentation/plugins/claude-agent-sdk-channels";
import type {
  ClaudeAgentSDKModule,
  ClaudeAgentSDKQueryParams,
} from "../../vendor-sdk-types/claude-agent-sdk";

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
      const invocationTarget: unknown =
        thisArg === proxy || thisArg === undefined
          ? (defaultThis ?? thisArg)
          : thisArg;
      return claudeAgentSDKChannels.query.traceSync(
        // Async iterator shenanigans are handled purely in the plugin which consumes this channel emission.
        () => Reflect.apply(target, invocationTarget, [params]),
        // The channel carries no extra context fields, but the generated
        // StartOf<> type for Record<string, never> is overly strict here.
        { arguments: [params] } as never,
      );
    },
  });

  return proxy;
}

function claudeAgentSDKProxy(sdk: ClaudeAgentSDKModule): ClaudeAgentSDKModule {
  const cache = new Map<PropertyKey, unknown>();

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

      if (typeof value === "function") {
        const bound = value.bind(target);
        cache.set(prop, bound);
        return bound;
      }

      return value;
    },
  });
}
