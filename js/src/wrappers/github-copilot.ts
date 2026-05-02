import { gitHubCopilotChannels } from "../instrumentation/plugins/github-copilot-channels";
import type {
  GitHubCopilotClient,
  GitHubCopilotResumeSessionConfig,
  GitHubCopilotSession,
  GitHubCopilotSessionConfig,
} from "../vendor-sdk-types/github-copilot";

function isGitHubCopilotClient(value: unknown): value is GitHubCopilotClient {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as GitHubCopilotClient).createSession === "function" &&
    typeof (value as GitHubCopilotClient).resumeSession === "function"
  );
}

/**
 * Wrap a CopilotClient instance (created with `new CopilotClient(...)`) with
 * Braintrust tracing.
 *
 * The wrapper intercepts `createSession` and `resumeSession` so that the same
 * plugin logic used by auto-instrumentation applies — session spans, turn
 * spans, LLM spans with token metrics, and tool spans are all produced.
 *
 * @example
 * ```ts
 * import { CopilotClient, approveAll } from "@github/copilot-sdk";
 * import { wrapCopilotClient } from "braintrust";
 *
 * const client = wrapCopilotClient(new CopilotClient());
 * const session = await client.createSession({
 *   model: "gpt-4.1",
 *   onPermissionRequest: approveAll,
 * });
 * ```
 */
export function wrapCopilotClient<T extends object>(client: T): T {
  if (!isGitHubCopilotClient(client)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(
      "[Braintrust] wrapCopilotClient: argument does not look like a CopilotClient. Not wrapping.",
    );
    return client;
  }

  return copilotClientProxy(client) as T;
}

function copilotClientProxy(client: GitHubCopilotClient): GitHubCopilotClient {
  const privateMethodCache = new WeakMap<
    (...args: unknown[]) => unknown,
    (...args: unknown[]) => unknown
  >();

  const proxy: GitHubCopilotClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "createSession") {
        return wrappedCreateSession(target);
      }

      if (prop === "resumeSession") {
        return wrappedResumeSession(target);
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }

      const cached = privateMethodCache.get(value);
      if (cached) {
        return cached;
      }

      const bound = function (this: unknown, ...args: unknown[]): unknown {
        const thisArg = this === proxy ? target : this;
        const result = Reflect.apply(value, thisArg, args);
        return result === target ? proxy : result;
      };

      privateMethodCache.set(value, bound);
      return bound;
    },
  });

  return proxy;
}

function wrappedCreateSession(
  client: GitHubCopilotClient,
): (config: GitHubCopilotSessionConfig) => Promise<GitHubCopilotSession> {
  return (config: GitHubCopilotSessionConfig) =>
    gitHubCopilotChannels.createSession.tracePromise(
      () => client.createSession(config),
      { arguments: [config] },
    );
}

function wrappedResumeSession(
  client: GitHubCopilotClient,
): (
  sessionId: string,
  config: GitHubCopilotResumeSessionConfig,
) => Promise<GitHubCopilotSession> {
  return (sessionId: string, config: GitHubCopilotResumeSessionConfig) =>
    gitHubCopilotChannels.resumeSession.tracePromise(
      () => client.resumeSession(sessionId, config),
      { arguments: [sessionId, config] },
    );
}
