import { googleADKChannels } from "../instrumentation/plugins/google-adk-channels";
import type {
  GoogleADKRunner,
  GoogleADKRunnerConstructor,
  GoogleADKInMemoryRunnerConstructor,
  GoogleADKBaseAgent,
  GoogleADKBaseTool,
  GoogleADKRunAsyncParams,
  GoogleADKToolRunRequest,
} from "../vendor-sdk-types/google-adk";

/**
 * Wrap a Google ADK module (imported with `import * as adk from '@google/adk'`) to add tracing.
 * If Braintrust is not configured, nothing will be traced.
 *
 * This wraps:
 * - Runner.runAsync / InMemoryRunner.runAsync — top-level agent execution
 * - BaseAgent.runAsync (and all subclasses) — individual agent invocations
 * - BaseTool.runAsync / FunctionTool.runAsync — tool execution
 *
 * LLM calls are already traced via the existing @google/genai instrumentation,
 * since ADK uses GenAI internally.
 *
 * @param adkModule The Google ADK module
 * @returns The wrapped Google ADK module
 *
 * @example
 * ```typescript
 * import * as adk from '@google/adk';
 * import { wrapGoogleADK, initLogger } from 'braintrust';
 *
 * initLogger({ projectName: 'Your project' });
 * const { LlmAgent, InMemoryRunner } = wrapGoogleADK(adk);
 *
 * const agent = new LlmAgent({ name: 'my_agent', model: 'gemini-2.5-flash' });
 * const runner = new InMemoryRunner({ agent });
 * for await (const event of runner.runAsync({ userId: 'u1', sessionId: 's1', newMessage: ... })) {
 *   console.log(event);
 * }
 * ```
 */
export function wrapGoogleADK<T extends Record<string, any>>(adkModule: T): T {
  if (!adkModule || typeof adkModule !== "object") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Invalid Google ADK module. Not wrapping.");
    return adkModule;
  }

  if (!("Runner" in adkModule) && !("LlmAgent" in adkModule)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(
      "Runner or LlmAgent class not found in module. Not wrapping. Make sure you're passing the module itself (import * as adk from '@google/adk').",
    );
    return adkModule;
  }

  return new Proxy(adkModule, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Wrap runner classes
      if (prop === "Runner" && typeof value === "function") {
        return wrapRunnerClass(value as GoogleADKRunnerConstructor);
      }
      if (prop === "InMemoryRunner" && typeof value === "function") {
        return wrapRunnerClass(
          value as unknown as GoogleADKInMemoryRunnerConstructor,
        );
      }

      // Wrap agent classes — all agents go through BaseAgent.runAsync
      if (
        (prop === "LlmAgent" ||
          prop === "Agent" ||
          prop === "SequentialAgent" ||
          prop === "ParallelAgent" ||
          prop === "LoopAgent") &&
        typeof value === "function"
      ) {
        return wrapAgentClass(value);
      }

      // Wrap tool classes
      if (prop === "FunctionTool" && typeof value === "function") {
        return wrapToolClass(value);
      }

      return value;
    },
  });
}

// ---- Runner wrapping ----

function wrapRunnerClass<
  T extends GoogleADKRunnerConstructor | GoogleADKInMemoryRunnerConstructor,
>(RunnerClass: T): T {
  return new Proxy(RunnerClass, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as GoogleADKRunner;
      return wrapRunnerInstance(instance);
    },
  }) as T;
}

function wrapRunnerInstance(runner: GoogleADKRunner): GoogleADKRunner {
  return new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === "runAsync") {
        return wrapRunnerRunAsync(target);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapRunnerRunAsync(
  runner: GoogleADKRunner,
): (params: GoogleADKRunAsyncParams) => AsyncGenerator<unknown> {
  const original = runner.runAsync.bind(runner);
  return function (params: GoogleADKRunAsyncParams) {
    return googleADKChannels.runnerRunAsync.traceSync(() => original(params), {
      arguments: [params],
      self: runner,
    } as Parameters<typeof googleADKChannels.runnerRunAsync.traceSync>[1]);
  };
}

// ---- Agent wrapping ----

function wrapAgentClass<T extends new (...args: any[]) => any>(
  AgentClass: T,
): T {
  return new Proxy(AgentClass, {
    construct(target, args) {
      const instance = Reflect.construct(target, args);
      return wrapAgentInstance(instance as GoogleADKBaseAgent);
    },
  }) as T;
}

function wrapAgentInstance(agent: GoogleADKBaseAgent): GoogleADKBaseAgent {
  return new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === "runAsync") {
        return wrapAgentRunAsync(target);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapAgentRunAsync(
  agent: GoogleADKBaseAgent,
): (parentContext: unknown) => AsyncGenerator<unknown> {
  const original = agent.runAsync.bind(agent);
  return function (parentContext: unknown) {
    return googleADKChannels.agentRunAsync.traceSync(
      () => original(parentContext),
      { arguments: [parentContext], self: agent } as Parameters<
        typeof googleADKChannels.agentRunAsync.traceSync
      >[1],
    );
  };
}

// ---- Tool wrapping ----

function wrapToolClass<T extends new (...args: any[]) => any>(ToolClass: T): T {
  return new Proxy(ToolClass, {
    construct(target, args) {
      const instance = Reflect.construct(target, args);
      return wrapToolInstance(instance as GoogleADKBaseTool);
    },
  }) as T;
}

function wrapToolInstance(tool: GoogleADKBaseTool): GoogleADKBaseTool {
  return new Proxy(tool, {
    get(target, prop, receiver) {
      if (prop === "runAsync") {
        return wrapToolRunAsync(target);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapToolRunAsync(
  tool: GoogleADKBaseTool,
): (req: GoogleADKToolRunRequest) => Promise<unknown> {
  const original = tool.runAsync.bind(tool);
  return function (req: GoogleADKToolRunRequest) {
    return googleADKChannels.toolRunAsync.tracePromise(() => original(req), {
      arguments: [req],
      self: tool,
    } as Parameters<typeof googleADKChannels.toolRunAsync.tracePromise>[1]);
  };
}
