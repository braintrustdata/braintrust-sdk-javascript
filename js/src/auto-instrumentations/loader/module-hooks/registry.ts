import type { InstrumentationIntegrationsConfig } from "../../../instrumentation/config";
import { isInstrumentationIntegrationDisabled } from "../../../instrumentation/config";
import semifies from "semifies";

export type ModuleExportPatchTarget = "node" | "browser";
type ModuleExportPatchFormat = "esm" | "cjs";
type MutableExportNamespace = Record<string, unknown>;

type RuntimeConstructor = new (...args: unknown[]) => object;

interface ModuleExportSource {
  modulePaths: readonly string[];
}

interface ModuleExportModule {
  packageName: string;
  patches: readonly ModuleExportConstructorPatch[];
  specifier: string;
  versionRange?: string;
  source?: ModuleExportSource;
}

interface ModuleExportConstructorPatch {
  channelName: string;
  exportName: string;
  kind: "constructor";
}

export interface ModuleExportPatchConfig {
  integrations: readonly (keyof InstrumentationIntegrationsConfig)[];
  modules: readonly ModuleExportModule[];
  targets: readonly ModuleExportPatchTarget[];
}

export interface ModuleExportPatchContext {
  moduleName: string;
  moduleVersion?: string;
  baseDir?: string;
  resolutionBase?: string;
}

export interface ModuleExportConstructorEvent extends ModuleExportPatchContext {
  arguments: unknown[];
  resolveModule(specifier: string): unknown;
}

export interface ModuleExportPatchRuntime {
  resolveModule(specifier: string, context: ModuleExportPatchContext): unknown;
  traceConstructor(
    channelName: string,
    event: ModuleExportConstructorEvent,
    construct: () => object,
  ): object;
}

interface ModuleExportSourceWrapperInput {
  baseDir?: string;
  format: ModuleExportPatchFormat;
  modulePath: string;
  moduleVersion?: string;
  originalModuleSpecifier: string;
  packageName: string;
  source: string;
  target: ModuleExportPatchTarget;
}

const MODULE_EXPORT_HOOK_RUNNER_GLOBAL = "__braintrustTopLevelImportHookRunner";

export function filterModuleExportPatchConfigs(
  configs: readonly ModuleExportPatchConfig[],
  {
    disabledIntegrationConfig,
    target,
  }: {
    disabledIntegrationConfig?: InstrumentationIntegrationsConfig;
    target: ModuleExportPatchTarget;
  },
): ModuleExportPatchConfig[] {
  return configs.filter(
    (config) =>
      config.targets.includes(target) &&
      !isInstrumentationIntegrationDisabled(
        disabledIntegrationConfig,
        ...config.integrations,
      ),
  );
}

export function getModuleExportPatchSpecifiers(
  configs: readonly ModuleExportPatchConfig[],
): string[] {
  return [
    ...new Set(
      configs.flatMap((config) =>
        config.modules.map((module) => module.specifier),
      ),
    ),
  ];
}

export function runModuleExportPatches(
  configs: readonly ModuleExportPatchConfig[],
  exportsValue: unknown,
  context: ModuleExportPatchContext,
  runtime: ModuleExportPatchRuntime,
): unknown {
  let namespace = asMutableNamespace(exportsValue);
  for (const config of configs) {
    for (const module of config.modules) {
      if (
        module.specifier !== context.moduleName ||
        !matchesVersion(context.moduleVersion, module.versionRange)
      ) {
        continue;
      }

      for (const patch of module.patches) {
        try {
          const original = namespace[patch.exportName];
          if (
            typeof original !== "function" ||
            isConstructorWrapped(original, patch.channelName)
          ) {
            continue;
          }

          const wrapped = wrapConstructor(
            original as RuntimeConstructor,
            patch.channelName,
            context,
            runtime,
          );
          namespace = setNamespaceExport(namespace, patch.exportName, wrapped);
        } catch {
          // Export patches are best-effort and must not break imports.
        }
      }
    }
  }
  return namespace;
}

export function installModuleExportPatchRunner(
  configs: readonly ModuleExportPatchConfig[],
  runtime: ModuleExportPatchRuntime,
): void {
  Object.defineProperty(globalThis, MODULE_EXPORT_HOOK_RUNNER_GLOBAL, {
    configurable: true,
    enumerable: false,
    value(
      exportsValue: unknown,
      name: string,
      baseDir?: string,
      resolutionBase?: string,
      moduleVersion?: string,
    ) {
      return runModuleExportPatches(
        configs,
        exportsValue,
        {
          baseDir,
          moduleName: name,
          moduleVersion,
          resolutionBase,
        },
        runtime,
      );
    },
    writable: true,
  });
}

export function buildModuleExportSourceWrapper(
  configs: readonly ModuleExportPatchConfig[],
  input: ModuleExportSourceWrapperInput,
): string | null {
  const sourceModules = configs
    .filter((config) => config.targets.includes(input.target))
    .flatMap((config) => config.modules)
    .filter(
      (module) =>
        module.packageName === input.packageName &&
        module.source?.modulePaths.includes(input.modulePath) &&
        matchesVersion(input.moduleVersion, module.versionRange),
    );

  if (sourceModules.length === 0) {
    return null;
  }

  const specifier = sourceModules[0].specifier;
  const exportNames = [
    ...new Set([
      ...sourceModules.flatMap((module) =>
        module.patches.map((patch) => patch.exportName),
      ),
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
        moduleVersion: input.moduleVersion,
        originalModuleSpecifier: input.originalModuleSpecifier,
      })
    : buildCjsSourceWrapper({
        baseDir: input.baseDir,
        exportNames,
        moduleName: specifier,
        moduleVersion: input.moduleVersion,
        originalModuleSpecifier: input.originalModuleSpecifier,
      });
}

function matchesVersion(
  moduleVersion: string | undefined,
  versionRange: string | undefined,
): boolean {
  if (!versionRange) return true;
  if (!moduleVersion) return false;

  try {
    return semifies(moduleVersion, versionRange);
  } catch {
    return false;
  }
}

function asMutableNamespace(exportsValue: unknown): MutableExportNamespace {
  if (exportsValue && typeof exportsValue === "object") {
    return exportsValue as MutableExportNamespace;
  }

  return { default: exportsValue };
}

function wrapConstructor(
  constructor: RuntimeConstructor,
  channelName: string,
  context: ModuleExportPatchContext,
  runtime: ModuleExportPatchRuntime,
): RuntimeConstructor {
  const marker = Symbol.for(
    `braintrust.module-export-constructor.${channelName}`,
  );
  return new Proxy(constructor, {
    construct(target, args, newTarget) {
      const event: ModuleExportConstructorEvent = {
        ...context,
        arguments: args.slice(),
        resolveModule(specifier) {
          return runtime.resolveModule(specifier, context);
        },
      };
      return runtime.traceConstructor(channelName, event, () =>
        Reflect.construct(target, event.arguments, newTarget),
      );
    },
    get(target, property, receiver) {
      if (property === marker) return true;
      return Reflect.get(target, property, receiver);
    },
  });
}

function isConstructorWrapped(value: Function, channelName: string): boolean {
  try {
    return (
      (value as unknown as Record<symbol, unknown>)[
        Symbol.for(`braintrust.module-export-constructor.${channelName}`)
      ] === true
    );
  } catch {
    return false;
  }
}

function setNamespaceExport(
  namespace: MutableExportNamespace,
  key: string,
  value: RuntimeConstructor,
): MutableExportNamespace {
  try {
    namespace[key] = value;
    if (namespace[key] === value) return namespace;
  } catch {
    // ESM namespaces are immutable; clone below.
  }

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
  ) as MutableExportNamespace;
}

function collectStaticExportNames(
  source: string,
  format: ModuleExportPatchFormat,
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
  moduleVersion,
  originalModuleSpecifier,
}: {
  baseDir?: string;
  exportNames: readonly string[];
  moduleName: string;
  moduleVersion?: string;
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
  const __braintrustHookRunner = globalThis[${JSON.stringify(MODULE_EXPORT_HOOK_RUNNER_GLOBAL)}];
  if (typeof __braintrustHookRunner === "function") {
    const __braintrustPatched = __braintrustHookRunner(
      __braintrustExports,
      ${JSON.stringify(moduleName)},
      ${JSON.stringify(baseDir)},
      import.meta.url,
      ${JSON.stringify(moduleVersion)},
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
  // Module export hooks are best-effort in bundled output.
}

export * from ${JSON.stringify(originalModuleSpecifier)};
${buildEsmExports(locals)}
`;
}

function buildCjsSourceWrapper({
  baseDir,
  exportNames,
  moduleName,
  moduleVersion,
  originalModuleSpecifier,
}: {
  baseDir?: string;
  exportNames: readonly string[];
  moduleName: string;
  moduleVersion?: string;
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
  const __braintrustHookRunner = globalThis[${JSON.stringify(MODULE_EXPORT_HOOK_RUNNER_GLOBAL)}];
  if (typeof __braintrustHookRunner === "function") {
    const __braintrustPatched = __braintrustHookRunner(
      __braintrustExports,
      ${JSON.stringify(moduleName)},
      ${JSON.stringify(baseDir)},
      typeof __filename === "string" ? __filename : undefined,
      ${JSON.stringify(moduleVersion)},
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
  // Module export hooks are best-effort in bundled output.
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
        `export { ${named.map(({ localName, exportName }) => `${localName} as ${exportName}`).join(", ")} };`,
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

function toSafeLocalName(exportName: string, index: number): string {
  return `__braintrust_export_${index}_${exportName.replace(/\W/g, "_")}`;
}
