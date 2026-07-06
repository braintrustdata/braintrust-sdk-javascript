/**
 * Runtime patches that auto-install the Braintrust observability exporter for
 * Mastra users.
 *
 * Two entry shapes need handling, and they're each different enough that we
 * pattern-match them separately rather than trying to share one strategy:
 *
 * 1. **`@mastra/core` `Mastra` entries** (`dist/index.{js,cjs}` and
 *    `dist/mastra/index.{js,cjs}`) are thin re-exports from a content-hashed
 *    chunk that changes filename every release:
 *
 *      // dist/index.js
 *      export { Mastra } from "./chunk-PLCLLPJL.js";
 *
 *    The entry filename itself is stable (pinned by the package's `exports`
 *    map), so we patch it — but a re-export has no local binding to mutate,
 *    so we have to rewrite the line into an explicit import + Proxy + export.
 *    That means extracting the chunk path with a regex. The regex pattern is
 *    stable; only the chunk hash inside the matched string changes.
 *
 * 2. **`@mastra/observability` `Observability` entry** (`dist/index.{js,cjs}`)
 *    inlines its class declaration in the entry itself:
 *
 *      var Observability = class extends MastraBase { ... };
 *      export { ..., Observability, ... };
 *
 *    Because the local `Observability` is a `var` binding, we can *append* a
 *    wrap (reassign `Observability` to a Proxy) and ESM's live-binding
 *    semantics propagate it to importers. No source rewrite needed, no chunk
 *    path involved.
 *
 * In both cases the generated wrapper is a `Proxy` with a `construct` trap.
 * On the Mastra side the trap injects an `Observability` instance into the
 * config when the user didn't pass one (via a factory registered on
 * `globalThis` by `hook.mjs`). On the Observability side the trap walks the
 * `configs` map and appends our exporter to any instance config that doesn't
 * already have one with `name === "braintrust"`.
 *
 * The patch is a no-op if the regex doesn't match (e.g., Mastra restructures
 * its build) or if our globalThis factory isn't present (e.g., user disabled
 * via `BRAINTRUST_DISABLE_INSTRUMENTATION=mastra`).
 */

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

// Entrypoints pinned by each package's `exports` map. Both Mastra entries
// (`dist/index.js` and `dist/mastra/index.js`) re-export `Mastra` from a
// chunk, so they both need the rewrite treatment.
const MASTRA_CORE_ENTRY_PATHS = new Set([
  "dist/index.js",
  "dist/index.cjs",
  "dist/mastra/index.js",
  "dist/mastra/index.cjs",
]);
const MASTRA_OBSERVABILITY_ENTRY_PATHS = new Set([
  "dist/index.js",
  "dist/index.cjs",
]);

type MastraTargetKind = "core" | "observability";
export type MastraModuleFormat = "esm" | "cjs";

export function classifyMastraTarget(
  packageName: string,
  modulePath: string,
): MastraTargetKind | null {
  if (
    packageName === MASTRA_CORE_PACKAGE &&
    MASTRA_CORE_ENTRY_PATHS.has(modulePath)
  ) {
    return "core";
  }
  if (
    packageName === MASTRA_OBSERVABILITY_PACKAGE &&
    MASTRA_OBSERVABILITY_ENTRY_PATHS.has(modulePath)
  ) {
    return "observability";
  }
  return null;
}

// Extract the chunk path from a Mastra entry source.
//   ESM shape: `export { Mastra } from "../chunk-XYZ.js";`
//   CJS shape: `var chunkXYZ_cjs = require("../chunk-XYZ.cjs"); ...`
// Returns null when the shape isn't what we expect — caller falls through and
// emits the original source unchanged so user code keeps working.
function extractChunkPath(source: string): string | null {
  const esmMatch = source.match(
    /export\s*\{\s*Mastra(?:\s+as\s+\w+)?\s*\}\s*from\s*['"]([^'"]+)['"]/,
  );
  if (esmMatch) return esmMatch[1];

  const cjsMatch = source.match(
    /require\s*\(\s*['"]([^'"]+chunk-[^'"]+)['"]\s*\)/,
  );
  if (cjsMatch) return cjsMatch[1];

  return null;
}

// All wrapper templates below are emitted as runtime JS in the target module's
// scope. They never reference Braintrust SDK code directly — instead they look
// up a factory function on `globalThis` (registered by `hook.mjs`). That keeps
// the patch independent of how the user's module graph resolves `braintrust`,
// and lets us cleanly no-op when the user disables our integration via env.

const EXPORTER_FACTORY_KEY = JSON.stringify(MASTRA_EXPORTER_FACTORY_GLOBAL);

// Construct-trap body shared between ESM and CJS wrappers. The wrapper loads
// `@mastra/observability` at module-evaluation time from the Mastra entry's
// own location (so the resolver finds the user's `node_modules`, not our
// SDK's). When the user constructs `new Mastra(...)` without an observability
// config, the trap injects a default `Observability` — which, because it
// loaded through our patched ESM hook / CJS patch, already auto-installs the
// Braintrust exporter via its own constructor wrap.
const MASTRA_PROXY_HANDLER_BODY = `
{
  construct(target, args, newTarget) {
    var firstArg = args[0];
    if (
      (!firstArg || typeof firstArg !== "object" || !firstArg.observability) &&
      __braintrustObservabilityClass
    ) {
      try {
        // serviceName is required by Mastra's Observability validator; pass
        // something sensible by default. Users who want a different name
        // should construct Observability themselves.
        var observability = new __braintrustObservabilityClass({
          configs: { default: { serviceName: "mastra" } },
        });
        args = args.slice();
        args[0] = Object.assign({}, firstArg, { observability: observability });
      } catch (e) {
        // Fall through. Mastra will use its own NoOp; user code still works,
        // just without auto-instrumentation.
      }
    }
    return Reflect.construct(target, args, newTarget);
  },
}`;

function buildMastraEsmWrapper(chunkPath: string): string {
  const chunk = JSON.stringify(chunkPath);
  return `import { Mastra as __braintrustOrigMastra } from ${chunk};
import { createRequire as __braintrustCreateRequire } from "node:module";

let __braintrustObservabilityClass = null;
try {
  // Resolve @mastra/observability relative to this module (the Mastra entry),
  // so it's looked up from the user's node_modules tree.
  const __braintrustRequire = __braintrustCreateRequire(import.meta.url);
  __braintrustObservabilityClass =
    __braintrustRequire("@mastra/observability").Observability;
} catch (e) {
  // @mastra/observability isn't installed; the construct trap will skip the
  // auto-construct branch and Mastra falls back to its own NoOp.
}
const Mastra = new Proxy(__braintrustOrigMastra, ${MASTRA_PROXY_HANDLER_BODY});
export { Mastra };
`;
}

function buildMastraCjsWrapper(chunkPath: string): string {
  const chunk = JSON.stringify(chunkPath);
  return `'use strict';
const __braintrustChunk = require(${chunk});

let __braintrustObservabilityClass = null;
try {
  __braintrustObservabilityClass = require("@mastra/observability").Observability;
} catch (e) {
  // @mastra/observability isn't installed; same fallback as the ESM wrapper.
}

const __braintrustWrappedMastra = new Proxy(
  __braintrustChunk.Mastra,
  ${MASTRA_PROXY_HANDLER_BODY},
);
Object.defineProperty(exports, "Mastra", {
  enumerable: true,
  configurable: true,
  get: function () { return __braintrustWrappedMastra; }
});
`;
}

// Appended to the end of `@mastra/observability/dist/index.{js,cjs}`. The
// entry declares `var Observability = class extends MastraBase { ... }`,
// which means we can reassign the binding from inside the same module after
// the class is created and the export line has run. ESM live-binding
// semantics make external importers see the new value; CJS lookups go
// through `exports.Observability`, which we redefine to mirror the wrap.
const OBSERVABILITY_APPEND_BODY = `
;(function __braintrustWrapObservability() {
  // Top-level so we can both read and reassign the var binding the original
  // entry declared.
  if (typeof Observability === "undefined") return;
  if (Observability.__braintrustWrapped) return;
  function __braintrustEnsureExporter(rawConfig) {
    try {
      var factory = globalThis[${EXPORTER_FACTORY_KEY}];
      if (typeof factory !== "function") return rawConfig;
      var config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
      var configsIn = config.configs && typeof config.configs === "object" ? config.configs : null;
      var configsOut = {};
      var hadEntries = false;
      if (configsIn) {
        for (var name in configsIn) {
          if (!Object.prototype.hasOwnProperty.call(configsIn, name)) continue;
          hadEntries = true;
          var inst = configsIn[name] || {};
          var existing = Array.isArray(inst.exporters) ? inst.exporters : [];
          var hasOurs = existing.some(function (e) { return e && e.name === "braintrust"; });
          configsOut[name] = Object.assign({}, inst, {
            exporters: hasOurs ? existing : existing.concat([factory()]),
          });
        }
      }
      if (!hadEntries) {
        configsOut.default = {
          serviceName: "mastra",
          exporters: [factory()],
        };
      }
      return Object.assign({}, config, { configs: configsOut });
    } catch (e) {
      return rawConfig;
    }
  }
  var __OriginalObservability = Observability;
  Observability = new Proxy(__OriginalObservability, {
    construct: function (target, args, newTarget) {
      var nextArgs = args.slice();
      nextArgs[0] = __braintrustEnsureExporter(nextArgs[0]);
      return Reflect.construct(target, nextArgs, newTarget);
    },
  });
  Observability.__braintrustWrapped = true;
  if (typeof exports !== "undefined" && exports && typeof exports === "object") {
    try {
      Object.defineProperty(exports, "Observability", {
        enumerable: true,
        configurable: true,
        get: function () { return Observability; },
      });
    } catch (e) {}
  }
})();
`;

export function patchMastraSource(
  source: string,
  target: MastraTargetKind,
  format: MastraModuleFormat,
): string {
  if (target === "core") {
    const chunkPath = extractChunkPath(source);
    if (!chunkPath) return source;
    return format === "esm"
      ? buildMastraEsmWrapper(chunkPath)
      : buildMastraCjsWrapper(chunkPath);
  }
  // Observability: append-wrap, leaving original source intact above.
  return source + OBSERVABILITY_APPEND_BODY;
}
