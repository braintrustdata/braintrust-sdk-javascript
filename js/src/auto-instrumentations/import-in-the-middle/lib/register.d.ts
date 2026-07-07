export type Namespace = Record<string | symbol, unknown>;

export function register(
  name: string,
  namespace: Namespace,
  set: Record<string | symbol, (value: unknown) => boolean>,
  get: Record<string | symbol, () => unknown>,
  specifier?: string,
): void;

declare const registerState: {
  addHookedModules(modules: readonly string[]): void;
  deleteHookedModules(modules: readonly string[]): void;
  hookedModules: Set<string>;
  importHooks: Array<
    (name: string, namespace: Namespace, specifier?: string) => void
  >;
  register: typeof register;
  specifiers: Map<string, string | undefined>;
  toHook: Array<[name: string, namespace: Namespace, specifier?: string]>;
};

export default registerState;
