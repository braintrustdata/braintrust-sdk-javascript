import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debugLogger } from "../../debug-logger";
import iso, { type IsoChannelHandlers } from "../../isomorph";
import type { ModuleExportConstructorEvent } from "../../auto-instrumentations/loader/module-hooks/registry";
import { MastraPlugin } from "./mastra-plugin";
import { mastraChannels } from "./mastra-channels";

vi.mock("../../wrappers/mastra", () => ({
  BraintrustObservabilityExporter: class {
    readonly name = "braintrust";
  },
}));

const originalNewTracingChannel = iso.newTracingChannel;
const channels = new Map<string, FakeTracingChannel>();

beforeEach(() => {
  channels.clear();
  iso.newTracingChannel = vi.fn((name: string | object) => {
    const channel = new FakeTracingChannel();
    channels.set(String(name), channel);
    return channel;
  }) as typeof iso.newTracingChannel;
});

afterEach(() => {
  iso.newTracingChannel = originalNewTracingChannel;
  vi.restoreAllMocks();
});

describe("MastraPlugin", () => {
  it("preserves Observability configs and appends one Braintrust exporter", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    const event = constructorEvent([
      {
        custom: "kept",
        configs: {
          default: {
            exporters: [{ name: "other" }],
            serviceName: "service",
          },
          secondary: { customValue: true, serviceName: "secondary" },
        },
      },
    ]);

    start(mastraChannels.observabilityConstructor, event);

    expect(event.arguments[0]).toEqual({
      custom: "kept",
      configs: {
        default: {
          exporters: [{ name: "other" }, { name: "braintrust" }],
          serviceName: "service",
        },
        secondary: {
          customValue: true,
          exporters: [{ name: "braintrust" }],
          serviceName: "secondary",
        },
      },
    });
  });

  it("does not duplicate an existing Braintrust exporter", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    const existing = { name: "braintrust" };
    const event = constructorEvent([
      {
        configs: {
          default: { exporters: [existing], serviceName: "service" },
        },
      },
    ]);

    start(mastraChannels.observabilityConstructor, event);

    expect(
      (
        event.arguments[0] as {
          configs: { default: { exporters: unknown[] } };
        }
      ).configs.default.exporters,
    ).toEqual([existing]);
  });

  it("creates a default Observability config", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    const event = constructorEvent([undefined]);

    start(mastraChannels.observabilityConstructor, event);

    expect(event.arguments[0]).toEqual({
      configs: {
        default: {
          exporters: [{ name: "braintrust" }],
          serviceName: "mastra",
        },
      },
    });
  });

  it("injects Observability into Mastra constructor arguments", () => {
    class Observability {
      constructor(public readonly config: unknown) {}
    }
    const plugin = new MastraPlugin();
    plugin.enable();
    const event = constructorEvent([{ custom: "kept" }], () => ({
      Observability,
    }));

    start(mastraChannels.mastraConstructor, event);

    const config = event.arguments[0] as {
      custom: string;
      observability: Observability;
    };
    expect(config.custom).toBe("kept");
    expect(config.observability).toBeInstanceOf(Observability);
    expect(config.observability.config).toEqual({
      configs: { default: { serviceName: "mastra" } },
    });
  });

  it.each([false, undefined, { user: true }])(
    "preserves an explicitly provided observability value: %j",
    (observability) => {
      const plugin = new MastraPlugin();
      plugin.enable();
      const event = constructorEvent([{ observability }], () => {
        throw new Error("should not resolve");
      });

      start(mastraChannels.mastraConstructor, event);

      expect(event.arguments[0]).toEqual({ observability });
    },
  );

  it("leaves Mastra arguments unchanged when Observability cannot be resolved", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    const original = { custom: true };
    const event = constructorEvent([original], () => undefined);

    start(mastraChannels.mastraConstructor, event);

    expect(event.arguments[0]).toBe(original);
  });

  it("contains subscriber errors and logs a warning", () => {
    const warn = vi.spyOn(debugLogger, "warn").mockImplementation(() => {});
    const plugin = new MastraPlugin();
    plugin.enable();
    const event = constructorEvent([{}], () => {
      throw new Error("resolution failed");
    });

    expect(() => start(mastraChannels.mastraConstructor, event)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "Failed to configure Mastra observability",
      expect.any(Error),
    );
  });

  it("unsubscribes both channels when disabled", () => {
    const plugin = new MastraPlugin();
    plugin.enable();
    plugin.disable();

    expect(channels.get(mastraChannels.mastraConstructor)?.handlers.size).toBe(
      0,
    );
    expect(
      channels.get(mastraChannels.observabilityConstructor)?.handlers.size,
    ).toBe(0);
  });
});

class FakeTracingChannel {
  readonly handlers = new Set<
    IsoChannelHandlers<ModuleExportConstructorEvent>
  >();

  subscribe(handlers: IsoChannelHandlers<ModuleExportConstructorEvent>): void {
    this.handlers.add(handlers);
  }

  unsubscribe(
    handlers: IsoChannelHandlers<ModuleExportConstructorEvent>,
  ): boolean {
    return this.handlers.delete(handlers);
  }

  get hasSubscribers(): boolean {
    return this.handlers.size > 0;
  }

  traceSync<T>(fn: () => T): T {
    return fn();
  }

  tracePromise<T>(fn: () => PromiseLike<T>): PromiseLike<T> {
    return fn();
  }

  traceCallback<T>(fn: () => T): T {
    return fn();
  }
}

function constructorEvent(
  args: unknown[],
  resolveModule: (specifier: string) => unknown = () => undefined,
): ModuleExportConstructorEvent {
  return {
    arguments: args,
    moduleName: "pkg",
    resolveModule,
  };
}

function start(channelName: string, event: ModuleExportConstructorEvent): void {
  for (const handlers of channels.get(channelName)?.handlers ?? []) {
    handlers.start?.(event, channelName);
  }
}
