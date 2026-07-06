import { afterEach, describe, expect, it, vi } from "vitest";
import type { IsoChannelHandlers } from "../isomorph";
import type { ChannelMessage } from "../instrumentation/core/channel-definitions";
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
  const tracingChannel = genkitChannels.actionRun.tracingChannel();
  const handlers: IsoChannelHandlers<
    ChannelMessage<typeof genkitChannels.actionRun>
  >[] = [];

  afterEach(() => {
    for (const handler of handlers.splice(0)) {
      tracingChannel.unsubscribe(handler);
    }
    vi.restoreAllMocks();
  });

  it("wraps actions resolved from the Genkit registry by tool name", async () => {
    const actionRunEvents: Array<{
      phase: "start" | "asyncEnd";
      event: ChannelMessage<typeof genkitChannels.actionRun>;
    }> = [];
    const handler: IsoChannelHandlers<
      ChannelMessage<typeof genkitChannels.actionRun>
    > = {
      asyncEnd: (event) => {
        actionRunEvents.push({ event, phase: "asyncEnd" });
      },
      start: (event) => {
        actionRunEvents.push({ event, phase: "start" });
      },
    };
    tracingChannel.subscribe(handler);
    handlers.push(handler);

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
