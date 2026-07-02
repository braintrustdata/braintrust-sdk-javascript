export interface HookOptions {
  internals?: boolean;
}

export type OnRequireFn = <T>(exports: T, name: string, basedir?: string) => T;

export class Hook {
  constructor(modules: string[], onrequire: OnRequireFn);
  unhook(): void;
}
