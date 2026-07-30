/**
 * Runtime hook implementation for Mastra top-level exports.
 *
 * The IITM/RITM adapters pass real module export objects here. Bundler/source
 * adapters generate wrapper modules that build the same mutable namespace
 * facade, call the shared hook runner, and re-export the updated bindings.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Name of the `globalThis` property the generated patches read to look up the
 * Braintrust exporter factory at runtime. Set by `hook.mjs` (loader path) and
 * by `configureNode()` (main braintrust import — covers the bundler-plugin
 * path where the patched module is built into the user's bundle rather than
 * loaded via the ESM hook). Both call sites use `installMastraExporterFactory`
 * below so the `??=` lives in one place. Kept module-private — external
 * callers should go through `installMastraExporterFactory`.
 */
const MASTRA_EXPORTER_FACTORY_GLOBAL = "__braintrustMastraExporterFactory";

/**
 * Idempotently install the Braintrust Mastra exporter factory on
 * `globalThis`. Callers are responsible for honoring
 * `BRAINTRUST_DISABLE_INSTRUMENTATION=mastra`; this helper is just the
 * `??=` placement.
 */
export function installMastraExporterFactory(factory: () => unknown): void {
  const globals = globalThis as Record<string, unknown>;
  globals[MASTRA_EXPORTER_FACTORY_GLOBAL] ??= factory;
}

const MASTRA_CORE_PACKAGE = "@mastra/core";
const MASTRA_OBSERVABILITY_PACKAGE = "@mastra/observability";
const MASTRA_CORE_MASTRA_SPECIFIER = "@mastra/core/mastra";
const MASTRA_RUNTIME_WRAPPED = Symbol.for(
  "braintrust.mastra.runtime-export-wrapped",
);

export interface MastraRuntimePatchContext {
  moduleName: string;
  baseDir?: string;
  resolutionBase?: string;
}

type RuntimeConstructor = new (...args: unknown[]) => unknown;

export function patchMastraExports<T>(
  exportsValue: T,
  context: MastraRuntimePatchContext,
): T {
  if (
    context.moduleName === MASTRA_CORE_PACKAGE ||
    context.moduleName === MASTRA_CORE_MASTRA_SPECIFIER
  ) {
    return patchMastraCoreExports(exportsValue, context) as T;
  } else if (context.moduleName === MASTRA_OBSERVABILITY_PACKAGE) {
    return patchMastraObservabilityExports(exportsValue) as T;
  }
  return exportsValue;
}

function patchMastraCoreExports(
  exportsValue: unknown,
  context: MastraRuntimePatchContext,
): unknown {
  if (!exportsValue || typeof exportsValue !== "object") return exportsValue;

  const namespace = exportsValue as Record<string, unknown>;
  const Mastra = asRuntimeConstructor(namespace.Mastra);
  if (!Mastra || isRuntimeWrapped(Mastra)) return exportsValue;

  const Observability = loadObservabilityClass(context);
  if (!Observability) return exportsValue;

  const wrapped = new Proxy(Mastra, {
    construct(target, args, newTarget) {
      const firstArg = args[0];
      if (
        (!firstArg ||
          typeof firstArg !== "object" ||
          !("observability" in firstArg) ||
          !(firstArg as { observability?: unknown }).observability) &&
        Observability
      ) {
        try {
          const observability = new Observability({
            configs: { default: { serviceName: "mastra" } },
          });
          const nextConfig =
            firstArg && typeof firstArg === "object"
              ? { ...(firstArg as Record<string, unknown>), observability }
              : { observability };
          return Reflect.construct(
            target,
            [nextConfig, ...args.slice(1)],
            newTarget,
          );
        } catch {
          // Mastra will keep its own fallback behavior if constructing
          // Observability fails.
        }
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  markRuntimeWrapped(wrapped);

  if (setNamespaceExport(namespace, "Mastra", wrapped)) {
    return exportsValue;
  }
  return cloneNamespaceWithExport(namespace, "Mastra", wrapped);
}

function patchMastraObservabilityExports(exportsValue: unknown): unknown {
  if (!exportsValue || typeof exportsValue !== "object") return exportsValue;

  const namespace = exportsValue as Record<string, unknown>;
  const Observability = asRuntimeConstructor(namespace.Observability);
  if (!Observability || isRuntimeWrapped(Observability)) {
    return exportsValue;
  }

  const wrapped = new Proxy(Observability, {
    construct(target, args, newTarget) {
      const nextArgs = args.slice();
      nextArgs[0] = ensureBraintrustExporter(nextArgs[0]);
      return Reflect.construct(target, nextArgs, newTarget);
    },
  });
  markRuntimeWrapped(wrapped);

  if (setNamespaceExport(namespace, "Observability", wrapped)) {
    return exportsValue;
  }
  return cloneNamespaceWithExport(namespace, "Observability", wrapped);
}

function loadObservabilityClass(
  context: MastraRuntimePatchContext,
): RuntimeConstructor | undefined {
  try {
    const requireFromMastra = createRequire(
      context.resolutionBase ??
        (context.baseDir
          ? join(context.baseDir, "package.json")
          : join(process.cwd(), "package.json")),
    );
    const observability = requireFromMastra(MASTRA_OBSERVABILITY_PACKAGE);
    patchMastraObservabilityExports(observability);
    return asRuntimeConstructor(observability?.Observability);
  } catch {
    return undefined;
  }
}

function ensureBraintrustExporter(rawConfig: unknown): unknown {
  try {
    const factory = (globalThis as Record<string, unknown>)[
      MASTRA_EXPORTER_FACTORY_GLOBAL
    ];
    if (typeof factory !== "function") return rawConfig;

    const config =
      rawConfig && typeof rawConfig === "object"
        ? (rawConfig as Record<string, unknown>)
        : {};
    const configsIn =
      config.configs && typeof config.configs === "object"
        ? (config.configs as Record<string, unknown>)
        : undefined;
    const configsOut: Record<string, unknown> = {};
    let hadEntries = false;

    if (configsIn) {
      for (const [name, rawInstanceConfig] of Object.entries(configsIn)) {
        hadEntries = true;
        const instanceConfig =
          rawInstanceConfig && typeof rawInstanceConfig === "object"
            ? (rawInstanceConfig as Record<string, unknown>)
            : {};
        const existing = Array.isArray(instanceConfig.exporters)
          ? instanceConfig.exporters
          : [];
        const hasOurs = existing.some(
          (exporter) =>
            exporter &&
            typeof exporter === "object" &&
            (exporter as { name?: unknown }).name === "braintrust",
        );
        configsOut[name] = {
          ...instanceConfig,
          exporters: hasOurs ? existing : [...existing, factory()],
        };
      }
    }

    if (!hadEntries) {
      configsOut.default = {
        serviceName: "mastra",
        exporters: [factory()],
      };
    }

    return { ...config, configs: configsOut };
  } catch {
    return rawConfig;
  }
}

function asRuntimeConstructor(value: unknown): RuntimeConstructor | undefined {
  return typeof value === "function"
    ? (value as RuntimeConstructor)
    : undefined;
}

function isRuntimeWrapped(value: RuntimeConstructor): boolean {
  return (
    (value as unknown as Record<symbol, unknown>)[MASTRA_RUNTIME_WRAPPED] ===
    true
  );
}

function markRuntimeWrapped(value: RuntimeConstructor): void {
  try {
    Object.defineProperty(value, MASTRA_RUNTIME_WRAPPED, {
      configurable: false,
      enumerable: false,
      value: true,
    });
  } catch {
    // Best effort only. Idempotence still holds through the export assignment.
  }
}

function setNamespaceExport(
  namespace: Record<string, unknown>,
  key: string,
  value: RuntimeConstructor,
): boolean {
  try {
    namespace[key] = value;
    if (namespace[key] === value) return true;
  } catch {
    // Try defineProperty below.
  }

  try {
    Object.defineProperty(namespace, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return namespace[key] === value;
  } catch {
    return false;
  }
}

function cloneNamespaceWithExport(
  namespace: Record<string, unknown>,
  key: string,
  value: RuntimeConstructor,
): Record<string, unknown> {
  return Object.defineProperties(
    Object.create(Object.getPrototypeOf(namespace)),
    {
      ...Object.getOwnPropertyDescriptors(namespace),
      [key]: {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      },
    },
  );
}
