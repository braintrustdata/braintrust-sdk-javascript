import iso from "../../isomorph";

type ClaudeLocalToolParentResolver = (toolUseId: string) => Promise<string>;

const localToolContextStore =
  iso.newAsyncLocalStorage<ClaudeLocalToolParentResolver>();
const localToolParentResolversByToolUseId = new Map<
  string,
  ClaudeLocalToolParentResolver
>();

export function runWithClaudeLocalToolContext<R>(
  callback: () => R,
  resolver: ClaudeLocalToolParentResolver,
): R {
  return localToolContextStore.run(resolver, callback);
}

export function registerClaudeLocalToolParentResolver(
  toolUseId: string,
  resolver: ClaudeLocalToolParentResolver,
): void {
  localToolParentResolversByToolUseId.set(toolUseId, resolver);
}

export function getClaudeLocalToolParentResolver(
  toolUseId?: string,
): ClaudeLocalToolParentResolver | undefined {
  const currentResolver = localToolContextStore.getStore();
  if (!toolUseId) {
    return currentResolver;
  }

  const registeredResolver = localToolParentResolversByToolUseId.get(toolUseId);
  localToolParentResolversByToolUseId.delete(toolUseId);
  return currentResolver ?? registeredResolver;
}
