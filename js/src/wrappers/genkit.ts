import { genkitChannels } from "../instrumentation/plugins/genkit-channels";
import type {
  GenkitAction,
  GenkitEmbedManyParams,
  GenkitEmbedParams,
  GenkitEmbedding,
  GenkitGenerateInput,
  GenkitGenerateResponse,
  GenkitGenerateStreamResponse,
  GenkitInstance,
} from "../vendor-sdk-types/genkit";

const WRAPPED_GENKIT = Symbol.for("braintrust.genkit.wrapped");
const PATCHED_GENKIT_REGISTRY = Symbol.for(
  "braintrust.genkit.registry.patched",
);
const PATCHED_GENKIT_REGISTRY_CONSTRUCTOR = Symbol.for(
  "braintrust.genkit.registry.constructor.patched",
);
const wrappedGenkitActions = new WeakMap<GenkitAction, GenkitAction>();

/**
 * Wrap a Genkit instance or module so Genkit calls emit diagnostics-channel
 * events that Braintrust plugins can consume.
 *
 * This supports both:
 * - `const ai = wrapGenkit(genkit({ ... }))`
 * - wrapping the module namespace and then calling its `genkit` factory
 */
export function wrapGenkit<T>(genkit: T): T {
  if (isGenkitInstance(genkit)) {
    return wrapGenkitInstance(genkit) as T;
  }

  if (isGenkitModule(genkit)) {
    return wrapGenkitModule(genkit) as T;
  }

  // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
  console.warn("Unsupported Genkit object. Not wrapping.");
  return genkit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPropertyBag(value: unknown): value is Record<PropertyKey, unknown> {
  return isRecord(value) || typeof value === "function";
}

function hasFunction(value: unknown, methodName: string): boolean {
  return (
    isPropertyBag(value) &&
    methodName in value &&
    typeof value[methodName] === "function"
  );
}

function isGenkitInstance(value: unknown): value is GenkitInstance {
  return (
    isRecord(value) &&
    (hasFunction(value, "generate") ||
      hasFunction(value, "generateStream") ||
      hasFunction(value, "defineFlow") ||
      hasFunction(value, "defineTool"))
  );
}

function isGenkitModule(value: unknown): value is Record<string, unknown> & {
  genkit: (...args: unknown[]) => unknown;
} {
  return hasFunction(value, "genkit");
}

function wrapGenkitModule<T extends Record<string, unknown>>(module: T): T {
  return new Proxy(module, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "genkit" && typeof value === "function") {
        const factory = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => wrapGenkit(factory(...args));
      }
      return value;
    },
  });
}

function wrapGenkitInstance(instance: GenkitInstance): GenkitInstance {
  if (hasWrappedFlag(instance)) {
    return instance;
  }

  patchGenkitRegistry(instance);

  const proxy = new Proxy(instance, {
    get(target, prop, receiver) {
      switch (prop) {
        case WRAPPED_GENKIT:
          return true;
        case "generate":
          return typeof target.generate === "function"
            ? wrapGenerate(target.generate.bind(target))
            : target.generate;
        case "generateStream":
          return typeof target.generateStream === "function"
            ? wrapGenerateStream(target.generateStream.bind(target))
            : target.generateStream;
        case "embed":
          return typeof target.embed === "function"
            ? wrapEmbed(target.embed.bind(target))
            : target.embed;
        case "embedMany":
          return typeof target.embedMany === "function"
            ? wrapEmbedMany(target.embedMany.bind(target))
            : target.embedMany;
        case "run":
          return typeof target.run === "function"
            ? wrapRun(target.run.bind(target))
            : target.run;
        case "defineFlow":
          return typeof target.defineFlow === "function"
            ? (...args: unknown[]) =>
                wrapGenkitAction(target.defineFlow!(...args))
            : target.defineFlow;
        case "defineTool":
          return typeof target.defineTool === "function"
            ? (...args: unknown[]) =>
                wrapGenkitAction(target.defineTool!(...args))
            : target.defineTool;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });

  return proxy;
}

function patchGenkitRegistry(instance: GenkitInstance): void {
  const registry = instance.registry;
  patchGenkitRegistryLookup(registry);
  patchGenkitRegistryConstructor(registry);
}

function patchGenkitRegistryLookup(registry: unknown): void {
  if (
    !isRecord(registry) ||
    hasRegistryPatchedFlag(registry) ||
    !hasFunction(registry, "lookupAction")
  ) {
    return;
  }

  const originalLookupAction = registry.lookupAction;
  if (typeof originalLookupAction !== "function") {
    return;
  }

  try {
    Object.defineProperty(registry, "lookupAction", {
      configurable: true,
      value: (...args: unknown[]) => {
        const result = originalLookupAction.apply(registry, args);
        if (isPromiseLike(result)) {
          return result.then((action) => wrapGenkitAction(action));
        }
        return wrapGenkitAction(result);
      },
      writable: true,
    });
    Object.defineProperty(registry, PATCHED_GENKIT_REGISTRY, {
      value: true,
    });
  } catch {
    // If Genkit makes the registry immutable, keep the returned action wrapper
    // path working and leave name-based resolution unmodified.
  }
}

function patchGenkitRegistryConstructor(registry: unknown): void {
  if (!isRecord(registry)) {
    return;
  }

  const constructor = registry.constructor;
  if (
    !isPropertyBag(constructor) ||
    hasRegistryConstructorPatchedFlag(constructor) ||
    !hasFunction(constructor, "withParent")
  ) {
    return;
  }

  const originalWithParent = constructor.withParent;
  if (typeof originalWithParent !== "function") {
    return;
  }

  try {
    Object.defineProperty(constructor, "withParent", {
      configurable: true,
      value: (...args: unknown[]) => {
        const childRegistry = originalWithParent.apply(constructor, args);
        if (args.some((arg) => isRecord(arg) && hasRegistryPatchedFlag(arg))) {
          patchGenkitRegistryLookup(childRegistry);
          patchGenkitRegistryConstructor(childRegistry);
        }
        return childRegistry;
      },
      writable: true,
    });
    Object.defineProperty(constructor, PATCHED_GENKIT_REGISTRY_CONSTRUCTOR, {
      value: true,
    });
  } catch {
    // Genkit may freeze constructors in future versions; direct registry
    // lookup patching still covers actions resolved from the wrapped instance.
  }
}

function wrapGenerate(
  generate: (input: GenkitGenerateInput) => Promise<GenkitGenerateResponse>,
): NonNullable<GenkitInstance["generate"]> {
  return (input) =>
    genkitChannels.generate.tracePromise(() => generate(input), {
      arguments: [input],
    });
}

function wrapGenerateStream(
  generateStream: (input: GenkitGenerateInput) => GenkitGenerateStreamResponse,
): NonNullable<GenkitInstance["generateStream"]> {
  return (input) =>
    genkitChannels.generateStream.traceSync(() => generateStream(input), {
      arguments: [input],
    } as Parameters<typeof genkitChannels.generateStream.traceSync>[1]);
}

function wrapEmbed(
  embed: (params: GenkitEmbedParams) => Promise<GenkitEmbedding[]>,
): NonNullable<GenkitInstance["embed"]> {
  return (params) =>
    genkitChannels.embed.tracePromise(() => embed(params), {
      arguments: [params],
    }) as Promise<GenkitEmbedding[]>;
}

function wrapEmbedMany(
  embedMany: (params: GenkitEmbedManyParams) => Promise<unknown>,
): NonNullable<GenkitInstance["embedMany"]> {
  return (params) =>
    genkitChannels.embedMany.tracePromise(() => embedMany(params), {
      arguments: [params],
    }) as Promise<unknown>;
}

function wrapRun(
  run: NonNullable<GenkitInstance["run"]>,
): NonNullable<GenkitInstance["run"]> {
  return (name, inputOrFn, maybeFn) =>
    genkitChannels.actionRun.tracePromise(() => run(name, inputOrFn, maybeFn), {
      arguments: [name, inputOrFn, maybeFn],
    } as Parameters<
      typeof genkitChannels.actionRun.tracePromise
    >[1]) as Promise<unknown>;
}

function wrapGenkitAction(action: GenkitAction): GenkitAction;
function wrapGenkitAction(action: unknown): unknown;
function wrapGenkitAction(action: unknown): unknown {
  if (!isGenkitAction(action) || hasWrappedFlag(action)) {
    return action;
  }

  const existing = wrappedGenkitActions.get(action);
  if (existing) {
    return existing;
  }

  const proxy = new Proxy(action, {
    apply(target, thisArg, argArray) {
      return traceActionRun(target, () =>
        Reflect.apply(target, thisArg, argArray),
      )(argArray[0], argArray[1]);
    },
    get(target, prop, receiver) {
      switch (prop) {
        case WRAPPED_GENKIT:
          return true;
        case "run":
          return typeof target.run === "function"
            ? traceActionRun(target, target.run.bind(target))
            : target.run;
        case "stream":
          return typeof target.stream === "function"
            ? traceActionStream(target, target.stream.bind(target))
            : target.stream;
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });

  wrappedGenkitActions.set(action, proxy);
  return proxy;
}

function isGenkitAction(value: unknown): value is GenkitAction {
  return (
    typeof value === "function" &&
    "__action" in (value as unknown as Record<PropertyKey, unknown>)
  );
}

function traceActionRun(
  action: GenkitAction,
  run: (input?: unknown, options?: unknown) => Promise<unknown>,
): (input?: unknown, options?: unknown) => Promise<unknown> {
  return (input, options) =>
    genkitChannels.actionRun.tracePromise(() => run(input, options), {
      arguments: [input, options],
      self: action,
    } as Parameters<
      typeof genkitChannels.actionRun.tracePromise
    >[1]) as Promise<unknown>;
}

function traceActionStream(
  action: GenkitAction,
  stream: NonNullable<GenkitAction["stream"]>,
): NonNullable<GenkitAction["stream"]> {
  return (input, options) =>
    genkitChannels.actionStream.traceSync(() => stream(input, options), {
      arguments: [input, options],
      self: action,
    } as Parameters<typeof genkitChannels.actionStream.traceSync>[1]);
}

function hasWrappedFlag(value: object): boolean {
  return Boolean((value as Record<PropertyKey, unknown>)[WRAPPED_GENKIT]);
}

function hasRegistryPatchedFlag(value: object): boolean {
  return Boolean(
    (value as Record<PropertyKey, unknown>)[PATCHED_GENKIT_REGISTRY],
  );
}

function hasRegistryConstructorPatchedFlag(value: object): boolean {
  return Boolean(
    (value as Record<PropertyKey, unknown>)[
      PATCHED_GENKIT_REGISTRY_CONSTRUCTOR
    ],
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && "then" in value && typeof value.then === "function";
}
