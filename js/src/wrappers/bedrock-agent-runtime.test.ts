import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { _exportsForTestingOnly, initLogger } from "../logger";
import { configureNode } from "../node/config";
import { wrapBedrockAgentRuntime } from "./bedrock-agent-runtime";

try {
  configureNode();
} catch {
  // Best-effort initialization for test environments.
}

class InvokeInlineAgentCommand {
  constructor(public input: Record<string, unknown>) {}
}

describe("wrapBedrockAgentRuntime", () => {
  let backgroundLogger: ReturnType<
    typeof _exportsForTestingOnly.useTestBackgroundLogger
  >;

  beforeAll(async () => {
    await _exportsForTestingOnly.simulateLoginForTests();
  });

  beforeEach(() => {
    backgroundLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    initLogger({
      projectName: "bedrock-agent-runtime.test.ts",
      projectId: "test-project-id",
    });
  });

  afterEach(() => {
    _exportsForTestingOnly.clearTestBackgroundLogger();
  });

  it("returns unsupported clients unchanged", () => {
    const value = { request: vi.fn() };
    expect(wrapBedrockAgentRuntime(value)).toBe(value);
  });

  it("is idempotent and preserves client methods", async () => {
    async function* completion() {
      yield {
        chunk: {
          bytes: new TextEncoder().encode("OK"),
        },
      };
    }
    const send = vi.fn(
      async (
        _command: InvokeInlineAgentCommand,
        _optionsOrCb?: unknown,
        _cb?: unknown,
      ) => ({
        completion: completion(),
        sessionId: "inline-session",
      }),
    );
    const client = {
      send,
      invokeInlineAgent(
        this: { send: typeof send },
        input: Record<string, unknown>,
      ) {
        return this.send(new InvokeInlineAgentCommand(input));
      },
    };

    const wrapped = wrapBedrockAgentRuntime(client);
    expect(wrapBedrockAgentRuntime(client)).toBe(wrapped);

    const response = await wrapped.invokeInlineAgent({
      foundationModel: "amazon.nova-lite-v1:0",
      inputText: "Reply with OK.",
      instruction: "Reply to the user concisely and accurately.",
      sessionId: "inline-session",
    });
    for await (const _event of response.completion) {
      // Consume the response so the instrumented span can finish.
    }

    expect(send).toHaveBeenCalledTimes(1);
    const spans = await backgroundLogger.drain();
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: "Reply with OK.",
          metadata: expect.objectContaining({
            command: "InvokeInlineAgentCommand",
            model: "amazon.nova-lite-v1:0",
            operation: "invokeInlineAgent",
            provider: "aws-bedrock",
          }),
          output: { text: "OK" },
          span_attributes: expect.objectContaining({
            name: "bedrockAgent.invokeInlineAgent",
            type: "task",
          }),
        }),
      ]),
    );
  });

  it("passes callback overloads through without tracing", async () => {
    const callback = vi.fn();
    const send = vi.fn(
      (
        _command: InvokeInlineAgentCommand,
        _optionsOrCb?: unknown,
        _cb?: unknown,
      ) => undefined,
    );
    const wrapped = wrapBedrockAgentRuntime({ send });
    const command = new InvokeInlineAgentCommand({
      foundationModel: "amazon.nova-lite-v1:0",
      instruction: "Reply to the user concisely and accurately.",
      sessionId: "inline-session",
    });

    wrapped.send(command, callback);

    expect(send).toHaveBeenCalledWith(command, callback, undefined);
    await expect(backgroundLogger.drain()).resolves.toEqual([]);
  });
});
