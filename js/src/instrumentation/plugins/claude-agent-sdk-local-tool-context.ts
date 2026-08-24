import iso from "../../isomorph";

type LocalToolParentResolver = (toolUseId: string) => Promise<string>;

export type ClaudeAgentSDKLocalToolContext = {
  resolveLocalToolParent?: LocalToolParentResolver;
};

const LOCAL_TOOL_CONTEXT_ASYNC_ITERATOR_PATCHED = Symbol.for(
  "braintrust.claude_agent_sdk.local_tool_context_async_iterator_patched",
);

type AsyncLocalStorageLike<T> = {
  getStore: () => T | undefined;
  run: <R>(store: T, callback: () => R) => R;
};

function createLocalToolContextStore(): AsyncLocalStorageLike<ClaudeAgentSDKLocalToolContext> {
  const maybeIsoWithAsyncLocalStorage = iso as {
    newAsyncLocalStorage?: <T>() => AsyncLocalStorageLike<T>;
  };

  if (
    typeof maybeIsoWithAsyncLocalStorage.newAsyncLocalStorage === "function"
  ) {
    return maybeIsoWithAsyncLocalStorage.newAsyncLocalStorage<ClaudeAgentSDKLocalToolContext>();
  }

  let currentStore: ClaudeAgentSDKLocalToolContext | undefined;
  return {
    getStore() {
      return currentStore;
    },
    run(store, callback) {
      const previousStore = currentStore;
      currentStore = store;
      try {
        return callback();
      } finally {
        currentStore = previousStore;
      }
    },
  };
}

const localToolContextStore = createLocalToolContextStore();
const localToolParentResolversByToolUseId = new Map<
  string,
  LocalToolParentResolver
>();

export function createClaudeLocalToolContext(): ClaudeAgentSDKLocalToolContext {
  return {};
}

export function runWithClaudeLocalToolContext<R>(
  callback: () => R,
  context?: ClaudeAgentSDKLocalToolContext,
): R {
  return localToolContextStore.run(
    context ?? createClaudeLocalToolContext(),
    callback,
  );
}

export function registerClaudeLocalToolParentResolver(
  toolUseId: string,
  resolver: LocalToolParentResolver,
): void {
  localToolParentResolversByToolUseId.set(toolUseId, resolver);
}

export function getClaudeLocalToolParentResolver(
  toolUseId?: string,
): LocalToolParentResolver | undefined {
  const currentResolver =
    localToolContextStore.getStore()?.resolveLocalToolParent;
  if (!toolUseId) {
    return currentResolver;
  }

  const registeredResolver = localToolParentResolversByToolUseId.get(toolUseId);
  localToolParentResolversByToolUseId.delete(toolUseId);
  return currentResolver ?? registeredResolver;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

export function bindClaudeLocalToolContextToAsyncIterable<T>(
  result: T,
  localToolContext: ClaudeAgentSDKLocalToolContext,
): T {
  if (
    !isAsyncIterable(result) ||
    Object.isFrozen(result) ||
    Object.isSealed(result)
  ) {
    return result;
  }

  const stream = result as AsyncIterable<unknown> & {
    [Symbol.asyncIterator]: (() => AsyncIterator<unknown>) & {
      [LOCAL_TOOL_CONTEXT_ASYNC_ITERATOR_PATCHED]?: boolean;
    };
  };
  const originalAsyncIterator = stream[Symbol.asyncIterator];
  if (originalAsyncIterator[LOCAL_TOOL_CONTEXT_ASYNC_ITERATOR_PATCHED]) {
    return result;
  }

  const patchedAsyncIterator = function (this: unknown) {
    return runWithClaudeLocalToolContext(() => {
      const iterator = Reflect.apply(originalAsyncIterator, this, []);
      if (!iterator || typeof iterator !== "object") {
        return iterator;
      }

      const patchMethod = (methodName: "next" | "return" | "throw") => {
        const originalMethod = Reflect.get(iterator, methodName);
        if (typeof originalMethod !== "function") {
          return;
        }

        Reflect.set(iterator, methodName, (...args: unknown[]) =>
          runWithClaudeLocalToolContext(
            () =>
              Reflect.apply(
                originalMethod as (...methodArgs: unknown[]) => unknown,
                iterator,
                args,
              ),
            localToolContext,
          ),
        );
      };

      patchMethod("next");
      patchMethod("return");
      patchMethod("throw");
      return iterator;
    }, localToolContext);
  };

  Object.defineProperty(
    patchedAsyncIterator,
    LOCAL_TOOL_CONTEXT_ASYNC_ITERATOR_PATCHED,
    {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
  );
  Reflect.set(stream, Symbol.asyncIterator, patchedAsyncIterator);
  return result;
}
