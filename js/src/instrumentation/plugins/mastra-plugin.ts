import { debugLogger } from "../../debug-logger";
import iso, { type IsoChannelHandlers } from "../../isomorph";
import { BraintrustObservabilityExporter } from "../../wrappers/mastra";
import { isObject } from "../../../util/index";
import type { ModuleExportConstructorEvent } from "../../auto-instrumentations/loader/module-hooks/registry";
import { BasePlugin } from "../core";
import { unsubscribeAll } from "../core/channel-tracing";
import { mastraChannels } from "./mastra-channels";

export class MastraPlugin extends BasePlugin {
  protected onEnable(): void {
    const mastraChannel = iso.newTracingChannel<ModuleExportConstructorEvent>(
      mastraChannels.mastraConstructor,
    );
    const mastraHandlers: IsoChannelHandlers<ModuleExportConstructorEvent> = {
      start(event) {
        try {
          const config = event.arguments[0];
          if (isObject(config) && "observability" in config) {
            return;
          }

          const observabilityModule = event.resolveModule(
            "@mastra/observability",
          );
          if (!isObject(observabilityModule)) {
            return;
          }
          const Observability = observabilityModule.Observability;
          if (typeof Observability !== "function") {
            return;
          }

          const observability = Reflect.construct(Observability, [
            { configs: { default: { serviceName: "mastra" } } },
          ]);
          event.arguments[0] = isObject(config)
            ? { ...config, observability }
            : { observability };
        } catch (error) {
          debugLogger.warn("Failed to configure Mastra observability", error);
        }
      },
    };
    mastraChannel.subscribe(mastraHandlers);
    this.unsubscribers.push(() => mastraChannel.unsubscribe(mastraHandlers));

    const observabilityChannel =
      iso.newTracingChannel<ModuleExportConstructorEvent>(
        mastraChannels.observabilityConstructor,
      );
    const observabilityHandlers: IsoChannelHandlers<ModuleExportConstructorEvent> =
      {
        start(event) {
          try {
            const rawConfig = event.arguments[0];
            const config = isObject(rawConfig) ? rawConfig : {};
            const configsIn = isObject(config.configs)
              ? config.configs
              : undefined;
            const configsOut: Record<string, unknown> = {};

            if (configsIn && Object.keys(configsIn).length > 0) {
              for (const [name, rawInstanceConfig] of Object.entries(
                configsIn,
              )) {
                const instanceConfig = isObject(rawInstanceConfig)
                  ? rawInstanceConfig
                  : {};
                const existingExporters = Array.isArray(
                  instanceConfig.exporters,
                )
                  ? instanceConfig.exporters
                  : [];
                const hasBraintrustExporter = existingExporters.some(
                  (exporter) =>
                    isObject(exporter) && exporter.name === "braintrust",
                );
                configsOut[name] = {
                  ...instanceConfig,
                  exporters: hasBraintrustExporter
                    ? existingExporters
                    : [
                        ...existingExporters,
                        new BraintrustObservabilityExporter(),
                      ],
                };
              }
            } else {
              configsOut.default = {
                exporters: [new BraintrustObservabilityExporter()],
                serviceName: "mastra",
              };
            }

            event.arguments[0] = { ...config, configs: configsOut };
          } catch (error) {
            debugLogger.warn(
              "Failed to configure the Braintrust Mastra exporter",
              error,
            );
          }
        },
      };
    observabilityChannel.subscribe(observabilityHandlers);
    this.unsubscribers.push(() =>
      observabilityChannel.unsubscribe(observabilityHandlers),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}
