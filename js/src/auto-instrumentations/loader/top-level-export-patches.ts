import type { InstrumentationIntegrationsConfig } from "../../instrumentation/config";
import { isInstrumentationIntegrationDisabled } from "../../instrumentation/config";
import { patchMastraExports } from "./mastra-observability-patch.js";

export type TopLevelImportHookTarget = "node" | "browser";
export type TopLevelImportHookFormat = "esm" | "cjs";
export type MutableExportNamespace = Record<string, unknown>;

export interface TopLevelImportHookSourceTarget {
  packageName: string;
  modulePaths: readonly string[];
  specifier: string;
  exportNames: readonly string[];
}

export interface TopLevelImportHook {
  integrations: readonly (keyof InstrumentationIntegrationsConfig)[];
  specifiers: readonly string[];
  targets: readonly TopLevelImportHookTarget[];
  sourceTargets?: readonly TopLevelImportHookSourceTarget[];
  hook(
    exports: MutableExportNamespace,
    name: string,
    baseDir?: string,
    resolutionBase?: string,
  ): unknown | void;
}

export interface TopLevelImportHookContext {
  moduleName: string;
  baseDir?: string;
  resolutionBase?: string;
}

export interface TopLevelImportHookSourceWrapperInput {
  baseDir?: string;
  format: TopLevelImportHookFormat;
  modulePath: string;
  originalModuleSpecifier: string;
  packageName: string;
  source: string;
  target: TopLevelImportHookTarget;
}

const TOP_LEVEL_IMPORT_HOOK_RUNNER_GLOBAL =
  "__braintrustTopLevelImportHookRunner";

export function getDefaultTopLevelImportHooks({
  disabledIntegrationConfig,
  target,
}: {
  disabledIntegrationConfig?: InstrumentationIntegrationsConfig;
  target: TopLevelImportHookTarget;
}): TopLevelImportHook[] {
  return defaultTopLevelImportHooks.filter(
    (hook) =>
      hook.targets.includes(target) &&
      !isInstrumentationIntegrationDisabled(
        disabledIntegrationConfig,
        ...hook.integrations,
      ),
  );
}

export function getTopLevelImportHookSpecifiers(
  hooks: readonly TopLevelImportHook[],
): string[] {
  return [...new Set(hooks.flatMap((hook) => hook.specifiers))];
}

export function runTopLevelImportHooks(
  hooks: readonly TopLevelImportHook[],
  exportsValue: unknown,
  context: TopLevelImportHookContext,
): unknown {
  let nextExports = exportsValue;
  for (const hook of hooks) {
    if (!matchesRuntimeHook(hook, context.moduleName)) {
      continue;
    }

    try {
      const patched = hook.hook(
        asMutableNamespace(nextExports),
        context.moduleName,
        context.baseDir,
        context.resolutionBase,
      );
      if (patched !== undefined) {
        nextExports = patched;
      }
    } catch {
      // Hook failures must never escape into user module evaluation.
    }
  }
  return nextExports;
}

export function installTopLevelImportHookRunner(
  hooks: readonly TopLevelImportHook[],
): void {
  Object.defineProperty(globalThis, TOP_LEVEL_IMPORT_HOOK_RUNNER_GLOBAL, {
    configurable: true,
    enumerable: false,
    value(
      exportsValue: unknown,
      name: string,
      baseDir?: string,
      resolutionBase?: string,
    ) {
      return runTopLevelImportHooks(hooks, exportsValue, {
        baseDir,
        moduleName: name,
        resolutionBase,
      });
    },
    writable: true,
  });
}

export function buildTopLevelImportHookSourceWrapper(
  hooks: readonly TopLevelImportHook[],
  input: TopLevelImportHookSourceWrapperInput,
): string | null {
  const sourceTargets = hooks
    .filter((hook) => hook.targets.includes(input.target))
    .flatMap((hook) => hook.sourceTargets ?? [])
    .filter(
      (sourceTarget) =>
        sourceTarget.packageName === input.packageName &&
        sourceTarget.modulePaths.includes(input.modulePath),
    );

  if (sourceTargets.length === 0) {
    return null;
  }

  const specifier = sourceTargets[0].specifier;
  const exportNames = [
    ...new Set([
      ...sourceTargets.flatMap((target) => target.exportNames),
      ...collectStaticExportNames(input.source, input.format),
    ]),
  ].sort((a, b) => Number(a === "default") - Number(b === "default"));

  if (exportNames.length === 0) {
    return null;
  }

  return input.format === "esm"
    ? buildEsmSourceWrapper({
        baseDir: input.baseDir,
        exportNames,
        moduleName: specifier,
        originalModuleSpecifier: input.originalModuleSpecifier,
      })
    : buildCjsSourceWrapper({
        baseDir: input.baseDir,
        exportNames,
        moduleName: specifier,
        originalModuleSpecifier: input.originalModuleSpecifier,
      });
}

export {
  getDefaultTopLevelImportHooks as getDefaultTopLevelExportPatches,
  getTopLevelImportHookSpecifiers as getTopLevelExportPatchSpecifiers,
  runTopLevelImportHooks as applyTopLevelExportRuntimePatches,
};

export type {
  TopLevelImportHook as TopLevelExportPatch,
  TopLevelImportHookContext as TopLevelExportPatchContext,
  TopLevelImportHookFormat as TopLevelExportPatchFormat,
  TopLevelImportHookTarget as TopLevelExportPatchTarget,
};

function matchesRuntimeHook(
  hook: TopLevelImportHook,
  moduleName: string,
): boolean {
  return hook.specifiers.includes(moduleName);
}

function asMutableNamespace(exportsValue: unknown): MutableExportNamespace {
  if (exportsValue && typeof exportsValue === "object") {
    return exportsValue as MutableExportNamespace;
  }

  return { default: exportsValue };
}

function collectStaticExportNames(
  source: string,
  format: TopLevelImportHookFormat,
): string[] {
  if (format === "cjs") {
    const names = new Set<string>();
    for (const match of source.matchAll(
      /\bexports\.([A-Za-z_$][\w$]*)\s*=|\bmodule\.exports\.([A-Za-z_$][\w$]*)\s*=|Object\.defineProperty\s*\(\s*exports\s*,\s*["']([^"']+)["']/g,
    )) {
      names.add(match[1] ?? match[2] ?? match[3]);
    }
    return [...names];
  }

  const names = new Set<string>();

  for (const match of source.matchAll(
    /\bexport\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1]);
  }

  if (/\bexport\s+default\b/.test(source)) {
    names.add("default");
  }

  for (const match of source.matchAll(
    /\bexport\s*\{([^}]+)\}(?:\s*from\s*["'][^"']+["'])?/g,
  )) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("type ")) continue;
      const aliasMatch = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*|default)$/);
      const directMatch = trimmed.match(/^([A-Za-z_$][\w$]*|default)$/);
      const name = aliasMatch?.[1] ?? directMatch?.[1];
      if (name) names.add(name);
    }
  }

  return [...names];
}

function buildEsmSourceWrapper({
  baseDir,
  exportNames,
  moduleName,
  originalModuleSpecifier,
}: {
  baseDir?: string;
  exportNames: readonly string[];
  moduleName: string;
  originalModuleSpecifier: string;
}): string {
  const locals = exportNames.map((name, index) => ({
    exportName: name,
    localName:
      name === "default"
        ? "__braintrustDefaultExport"
        : toSafeLocalName(name, index),
  }));

  return `import * as __braintrustOriginal from ${JSON.stringify(originalModuleSpecifier)};

${locals
  .map(
    ({ exportName, localName }) =>
      `let ${localName} = __braintrustOriginal[${JSON.stringify(exportName)}];`,
  )
  .join("\n")}

const __braintrustExports = Object.create(null);
${locals.map(({ exportName, localName }) => buildMutableExportDescriptor(exportName, localName)).join("\n")}

try {
  const __braintrustHookRunner = globalThis[${JSON.stringify(TOP_LEVEL_IMPORT_HOOK_RUNNER_GLOBAL)}];
  if (typeof __braintrustHookRunner === "function") {
    const __braintrustPatched = __braintrustHookRunner(
      __braintrustExports,
      ${JSON.stringify(moduleName)},
      ${JSON.stringify(baseDir)},
      import.meta.url,
    );
    if (__braintrustPatched && __braintrustPatched !== __braintrustExports) {
${locals
  .map(
    ({ exportName, localName }) =>
      `      if (Object.prototype.hasOwnProperty.call(__braintrustPatched, ${JSON.stringify(exportName)})) ${localName} = __braintrustPatched[${JSON.stringify(exportName)}];`,
  )
  .join("\n")}
    }
  }
} catch (e) {
  // Top-level import hooks are best-effort in bundled output.
}

export * from ${JSON.stringify(originalModuleSpecifier)};
${buildEsmExports(locals)}
`;
}

function buildCjsSourceWrapper({
  baseDir,
  exportNames,
  moduleName,
  originalModuleSpecifier,
}: {
  baseDir?: string;
  exportNames: readonly string[];
  moduleName: string;
  originalModuleSpecifier: string;
}): string {
  const locals = exportNames.map((name, index) => ({
    exportName: name,
    localName:
      name === "default"
        ? "__braintrustDefaultExport"
        : toSafeLocalName(name, index),
  }));
  const cjsRequire = "require";

  return `"use strict";
const __braintrustOriginal = ${cjsRequire}(${JSON.stringify(originalModuleSpecifier)});
const __braintrustPatchedExportNames = new Set(${JSON.stringify(exportNames)});
try {
  const __braintrustOriginalDescriptors = Object.getOwnPropertyDescriptors(__braintrustOriginal);
${locals.map(({ exportName }) => `  delete __braintrustOriginalDescriptors[${JSON.stringify(exportName)}];`).join("\n")}
  Object.defineProperties(exports, __braintrustOriginalDescriptors);
} catch (e) {
  for (const __braintrustKey in __braintrustOriginal) {
    if (!__braintrustPatchedExportNames.has(__braintrustKey)) {
      exports[__braintrustKey] = __braintrustOriginal[__braintrustKey];
    }
  }
}

${locals
  .map(
    ({ exportName, localName }) =>
      `let ${localName} = __braintrustOriginal[${JSON.stringify(exportName)}];`,
  )
  .join("\n")}

const __braintrustExports = Object.create(null);
${locals.map(({ exportName, localName }) => buildMutableExportDescriptor(exportName, localName)).join("\n")}

try {
  const __braintrustHookRunner = globalThis[${JSON.stringify(TOP_LEVEL_IMPORT_HOOK_RUNNER_GLOBAL)}];
  if (typeof __braintrustHookRunner === "function") {
    const __braintrustPatched = __braintrustHookRunner(
      __braintrustExports,
      ${JSON.stringify(moduleName)},
      ${JSON.stringify(baseDir)},
      typeof __filename === "string" ? __filename : undefined,
    );
    if (__braintrustPatched && __braintrustPatched !== __braintrustExports) {
${locals
  .map(
    ({ exportName, localName }) =>
      `      if (Object.prototype.hasOwnProperty.call(__braintrustPatched, ${JSON.stringify(exportName)})) ${localName} = __braintrustPatched[${JSON.stringify(exportName)}];`,
  )
  .join("\n")}
    }
  }
} catch (e) {
  // Top-level import hooks are best-effort in bundled output.
}

${locals.map(({ exportName, localName }) => buildCjsExportDescriptor(exportName, localName)).join("\n")}
`;
}

function buildMutableExportDescriptor(
  exportName: string,
  localName: string,
): string {
  return `Object.defineProperty(__braintrustExports, ${JSON.stringify(exportName)}, {
  configurable: true,
  enumerable: true,
  get() { return ${localName}; },
  set(value) { ${localName} = value; return true; },
});`;
}

function buildEsmExports(
  locals: readonly { exportName: string; localName: string }[],
): string {
  const named = locals.filter(({ exportName }) => exportName !== "default");
  const defaultExport = locals.find(
    ({ exportName }) => exportName === "default",
  );
  const lines = named.length
    ? [
        `export { ${named.map(({ localName, exportName }) => (localName === exportName ? exportName : `${localName} as ${exportName}`)).join(", ")} };`,
      ]
    : [];
  if (defaultExport) {
    lines.push(`export { ${defaultExport.localName} as default };`);
  }
  return lines.join("\n");
}

function buildCjsExportDescriptor(
  exportName: string,
  localName: string,
): string {
  return `Object.defineProperty(exports, ${JSON.stringify(exportName)}, {
  configurable: true,
  enumerable: true,
  get() { return ${localName}; },
});`;
}

const MASTRA_CORE_ENTRY_PATHS = [
  "dist/index.js",
  "dist/index.cjs",
  "dist/mastra/index.js",
  "dist/mastra/index.cjs",
];
const MASTRA_OBSERVABILITY_ENTRY_PATHS = ["dist/index.js", "dist/index.cjs"];

const mastraTopLevelImportHook: TopLevelImportHook = {
  hook(exportsValue, name, baseDir, resolutionBase) {
    return patchMastraExports(exportsValue, {
      baseDir,
      moduleName: name,
      resolutionBase,
    });
  },
  integrations: ["mastra"],
  sourceTargets: [
    {
      exportNames: ["Mastra"],
      modulePaths: MASTRA_CORE_ENTRY_PATHS.filter((path) =>
        path.startsWith("dist/index."),
      ),
      packageName: "@mastra/core",
      specifier: "@mastra/core",
    },
    {
      exportNames: ["Mastra"],
      modulePaths: MASTRA_CORE_ENTRY_PATHS.filter((path) =>
        path.startsWith("dist/mastra/"),
      ),
      packageName: "@mastra/core",
      specifier: "@mastra/core/mastra",
    },
    {
      exportNames: ["Observability"],
      modulePaths: MASTRA_OBSERVABILITY_ENTRY_PATHS,
      packageName: "@mastra/observability",
      specifier: "@mastra/observability",
    },
  ],
  specifiers: ["@mastra/core", "@mastra/core/mastra", "@mastra/observability"],
  targets: ["node"],
};

const defaultTopLevelImportHooks: readonly TopLevelImportHook[] = [
  mastraTopLevelImportHook,
];

function toSafeLocalName(exportName: string, index: number): string {
  return `__braintrust_export_${index}_${exportName.replace(/\W/g, "_")}`;
}
