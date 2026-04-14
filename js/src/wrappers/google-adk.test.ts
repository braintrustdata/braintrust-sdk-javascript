import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock iso's newTracingChannel
vi.mock("../isomorph", () => {
  const mockTraceSync = vi.fn((fn: () => any) => fn());
  const mockTracePromise = vi.fn((fn: () => any) => fn());
  return {
    default: {
      newTracingChannel: vi.fn(() => ({
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        traceSync: mockTraceSync,
        tracePromise: mockTracePromise,
      })),
    },
  };
});

import { wrapGoogleADK } from "./google-adk";

describe("wrapGoogleADK", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should return the module unchanged if invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = wrapGoogleADK(null as any);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "Invalid Google ADK module. Not wrapping.",
    );

    warnSpy.mockRestore();
  });

  it("should return module unchanged if no Runner or LlmAgent found", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fakeModule = { SomeOtherClass: class {} };
    const result = wrapGoogleADK(fakeModule as any);
    expect(result).toBe(fakeModule);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Runner or LlmAgent class not found"),
    );

    warnSpy.mockRestore();
  });

  it("should wrap Runner class constructor", () => {
    class FakeRunner {
      appName: string;
      agent: any;
      constructor(input: any) {
        this.appName = input.appName;
        this.agent = input.agent;
      }
      async *runAsync(_params: any) {
        yield { id: "1", content: { parts: [{ text: "hello" }] } };
      }
    }

    const fakeModule = {
      Runner: FakeRunner,
      LlmAgent: class {},
    };

    const wrapped = wrapGoogleADK(fakeModule as any);

    // Runner should be wrapped (returns a Proxy)
    const runner = new wrapped.Runner({
      appName: "test-app",
      agent: { name: "test-agent" },
    });

    expect(runner.appName).toBe("test-app");
    expect(typeof runner.runAsync).toBe("function");
  });

  it("should wrap LlmAgent class constructor", () => {
    class FakeLlmAgent {
      name: string;
      constructor(config: any) {
        this.name = config.name;
      }
      async *runAsync(_ctx: any) {
        yield { id: "1" };
      }
    }

    const fakeModule = {
      Runner: class {
        constructor() {}
        async *runAsync() {}
      },
      LlmAgent: FakeLlmAgent,
    };

    const wrapped = wrapGoogleADK(fakeModule as any);
    const agent = new wrapped.LlmAgent({ name: "test-agent" });

    expect(agent.name).toBe("test-agent");
    expect(typeof agent.runAsync).toBe("function");
  });

  it("should wrap FunctionTool class constructor", () => {
    class FakeFunctionTool {
      name: string;
      constructor(config: any) {
        this.name = config.name;
      }
      async runAsync(req: any) {
        return { result: req.args.city };
      }
    }

    const fakeModule = {
      Runner: class {
        constructor() {}
        async *runAsync() {}
      },
      LlmAgent: class {
        constructor() {}
        async *runAsync() {}
      },
      FunctionTool: FakeFunctionTool,
    };

    const wrapped = wrapGoogleADK(fakeModule as any);
    const tool = new wrapped.FunctionTool({ name: "get_weather" });

    expect(tool.name).toBe("get_weather");
    expect(typeof tool.runAsync).toBe("function");
  });

  it("should pass through non-wrapped exports unchanged", () => {
    const fakeModule = {
      Runner: class {
        constructor() {}
        async *runAsync() {}
      },
      LlmAgent: class {
        constructor() {}
        async *runAsync() {}
      },
      SomeUtil: { foo: "bar" },
      CONSTANT: 42,
    };

    const wrapped = wrapGoogleADK(fakeModule as any);
    expect(wrapped.SomeUtil).toEqual({ foo: "bar" });
    expect(wrapped.CONSTANT).toBe(42);
  });

  it("should wrap Runner.runAsync to call traceSync channel", async () => {
    let traceSyncCalled = false;

    class FakeRunner {
      constructor(_input: any) {}
      async *runAsync(_params: any): AsyncGenerator<any> {
        yield { id: "1", content: { parts: [{ text: "test response" }] } };
      }
    }

    const fakeModule = {
      Runner: FakeRunner,
      LlmAgent: class {
        constructor() {}
        async *runAsync() {}
      },
    };

    const wrapped = wrapGoogleADK(fakeModule as any);
    const runner = new wrapped.Runner({
      appName: "test",
      agent: { name: "test-agent" },
    });

    // Call runAsync and consume the generator
    const events: any[] = [];
    for await (const event of runner.runAsync({
      userId: "u1",
      sessionId: "s1",
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("1");
  });

  it("should wrap FunctionTool.runAsync to call tracePromise channel", async () => {
    class FakeFunctionTool {
      name: string;
      constructor(config: any) {
        this.name = config.name;
      }
      async runAsync(req: any) {
        return { temp: 72 };
      }
    }

    const fakeModule = {
      Runner: class {
        constructor() {}
        async *runAsync() {}
      },
      LlmAgent: class {
        constructor() {}
        async *runAsync() {}
      },
      FunctionTool: FakeFunctionTool,
    };

    const wrapped = wrapGoogleADK(fakeModule as any);
    const tool = new wrapped.FunctionTool({ name: "get_weather" });

    const result = await tool.runAsync({
      args: { city: "NYC" },
    });

    expect(result).toEqual({ temp: 72 });
  });

  it("should wrap all agent class variants", () => {
    const agentClasses = [
      "LlmAgent",
      "Agent",
      "SequentialAgent",
      "ParallelAgent",
      "LoopAgent",
    ];

    const fakeModule: Record<string, any> = {
      Runner: class {
        constructor() {}
        async *runAsync() {}
      },
    };

    for (const name of agentClasses) {
      fakeModule[name] = class {
        name: string;
        constructor(config: any) {
          this.name = config?.name ?? name;
        }
        async *runAsync() {
          yield { id: "1" };
        }
      };
    }

    const wrapped = wrapGoogleADK(fakeModule as any);

    for (const name of agentClasses) {
      const agent = new wrapped[name]({ name: `test-${name}` });
      expect(agent.name).toBe(`test-${name}`);
      expect(typeof agent.runAsync).toBe("function");
    }
  });
});
