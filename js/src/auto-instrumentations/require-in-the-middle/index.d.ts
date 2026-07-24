export type OnRequireFn<Exports = unknown, PatchedExports = Exports> = (
  exports: Exports,
  name: string,
  basedir?: string,
) => PatchedExports;

export interface Hook<Exports = unknown, PatchedExports = Exports> {
  unhook(): void;
}

export interface HookConstructor {
  new <Exports = unknown, PatchedExports = Exports>(
    modules: readonly string[],
    onrequire: OnRequireFn<Exports, PatchedExports>,
  ): Hook<Exports, PatchedExports>;
  <Exports = unknown, PatchedExports = Exports>(
    modules: readonly string[],
    onrequire: OnRequireFn<Exports, PatchedExports>,
  ): Hook<Exports, PatchedExports>;
}

export declare const Hook: HookConstructor;
export default Hook;
