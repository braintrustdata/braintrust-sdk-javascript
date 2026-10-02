import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelMessage } from "../instrumentation/core/tracing-types";
import { genkitChannels } from "../instrumentation/plugins/genkit-channels";
import { configureNode } from "../node/config";
import type {
  GenkitAction,
  GenkitGenerateInput,
} from "../vendor-sdk-types/genkit";
import { wrapGenkit } from "./genkit";

try {
  configureNode();
} catch {
  // The node configuration is process-global and may already be initialized.
}

describe("wrapGenkit", () => {
  const removals: Array<() => void> = [];
  afterEach(() => {
    for (const remove of removals.splice(0)) remove();
    vi.restoreAllMocks();
  });

  it("wraps actions resolved from the Genkit registry by tool name", async () => {
    const actionRunEvents: Array<{
      phase: "start" | "asyncEnd";
      event: ChannelMessage<typeof genkitChannels.actionRun>;
    }> = [];
    removals.push(
      genkitChannels.actionRun.intercept(
        (target, receiver, args, additional) => {
          const event = { ...additional, arguments: args, self: receiver };
          actionRunEvents.push({ event, phase: "start" });
          const result = Reflect.apply(target, receiver, args);
          result.then((value) =>
            actionRunEvents.push({
              event: { ...event, result: value },
              phase: "asyncEnd",
            }),
          );
          return result;
        },
      ),
    );

    const originalTool = Object.assign(
      vi.fn(async (input: unknown) => ({ echoed: input })),
      {
        __action: {
          actionType: "tool",
          name: "summarizeCity",
        },
      },
    ) as unknown as GenkitAction;
    const lookupAction = vi.fn(async () => originalTool);
    class FakeRegistry {
      lookupAction = lookupAction;

      static withParent() {
        return { lookupAction };
      }
    }
    const registry = new FakeRegistry();
    const genkitInstance = {
      defineTool: vi.fn(() => originalTool),
      generate: async (input: GenkitGenerateInput) => {
        const options =
          typeof input === "object" && input !== null && !Array.isArray(input)
            ? input
            : {};
        const typedOptions = options as any;
        const toolRef = Array.isArray(typedOptions.tools)
          ? typedOptions.tools[0]
          : undefined;
        if (typeof toolRef !== "string") {
          throw new Error("Expected a tool name");
        }

        const childRegistry = (FakeRegistry.withParent as any)(registry);
        const tool = await (childRegistry.lookupAction as any)(
          `/tool/${toolRef}`,
        );
        return (tool as any)({ city: "Vienna" });
      },
      registry,
    };

    const wrapped = wrapGenkit(genkitInstance as any) as any;
    wrapped.defineTool(
      {
        name: "summarizeCity",
      },
      async () => ({ summary: "Vienna" }),
    );

    await expect(
      wrapped.generate({
        prompt: "Use summarizeCity for Vienna.",
        tools: ["summarizeCity"],
      }),
    ).resolves.toEqual({
      echoed: {
        city: "Vienna",
      },
    });

    expect(originalTool).toHaveBeenCalledTimes(1);
    expect(lookupAction).toHaveBeenCalledWith("/tool/summarizeCity");
    expect(actionRunEvents.map((item) => item.phase)).toEqual([
      "start",
      "asyncEnd",
    ]);
    expect(actionRunEvents[0]?.event.self).toBe(originalTool);
    expect(Array.from(actionRunEvents[0]?.event.arguments ?? [])).toEqual([
      {
        city: "Vienna",
      },
      undefined,
    ]);
  });
});
