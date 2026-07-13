import moduleDetailsFromPath from "module-details-from-path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import registerState, {
  type ImportHook,
  type Namespace,
} from "../../import-in-the-middle/lib/register.mjs";

const {
  addHookedModules,
  deleteHookedModules,
  importHooks,
  specifiers,
  toHook,
} = registerState;

type HookFn = (exported: Namespace, name: string, baseDir?: string) => unknown;

function addHook(hook: ImportHook): void {
  importHooks.push(hook);
  toHook.forEach(([name, namespace, specifier]) =>
    hook(name, namespace, specifier),
  );
}

function removeHook(hook: ImportHook): void {
  const index = importHooks.indexOf(hook);
  if (index > -1) {
    importHooks.splice(index, 1);
  }
}

function callHookFn(
  hookFn: HookFn,
  namespace: Namespace,
  name: string,
  baseDir?: string,
): void {
  const newDefault = hookFn(namespace, name, baseDir);
  if (newDefault && newDefault !== namespace && "default" in namespace) {
    namespace.default = newDefault;
  }
}

function normalizeModules(modules: string[]): string[] {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError(
      "Braintrust import-in-the-middle requires a non-empty modules array",
    );
  }

  for (const each of modules) {
    if (typeof each !== "string") {
      throw new TypeError(
        "Braintrust import-in-the-middle only supports string module names or file URLs",
      );
    }
  }

  return modules;
}

function moduleMatches(
  matchArg: string,
  name: string,
  filePath: string | undefined,
  specifier: string | undefined,
  baseDir: string | undefined,
  loadUrl: string,
): boolean {
  if (filePath && matchArg === filePath) {
    return true;
  }

  if (matchArg === specifier || matchArg === loadUrl || matchArg === name) {
    return true;
  }

  if (!baseDir) {
    return false;
  }

  return matchArg === name && baseDir.endsWith(specifiers.get(loadUrl) ?? "");
}

export default class Hook {
  private readonly modules: string[];
  private readonly iitmHook: ImportHook;

  constructor(modules: string[], hookFn: HookFn) {
    modules = normalizeModules(modules);
    if (typeof hookFn !== "function") {
      throw new TypeError(
        "Braintrust import-in-the-middle requires a hook function",
      );
    }

    addHookedModules(modules);

    this.modules = modules;
    this.iitmHook = (name, namespace, specifier) => {
      const loadUrl = name;
      let filePath: string | undefined;
      let baseDir: string | undefined;

      if (loadUrl.startsWith("node:")) {
        const unprefixed = name.slice(5);
        if (isBuiltin(unprefixed)) {
          name = unprefixed;
        }
      } else if (loadUrl.startsWith("file://")) {
        const stackTraceLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 0;
        try {
          filePath = fileURLToPath(name);
          name = filePath;
        } catch {}
        Error.stackTraceLimit = stackTraceLimit;

        if (filePath) {
          const details = moduleDetailsFromPath(filePath);
          if (details) {
            name = details.name;
            baseDir = details.basedir;
          }
        }
      }

      for (const matchArg of modules) {
        if (
          moduleMatches(matchArg, name, filePath, specifier, baseDir, loadUrl)
        ) {
          callHookFn(
            hookFn,
            namespace,
            filePath && matchArg === filePath ? filePath : matchArg,
            baseDir,
          );
        }
      }
    };

    addHook(this.iitmHook);
  }

  unhook(): void {
    removeHook(this.iitmHook);
    deleteHookedModules(this.modules);
  }
}
