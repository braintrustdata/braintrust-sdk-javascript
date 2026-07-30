// Forked from import-in-the-middle@3.2.0. Modified by Braintrust.

import type { MessagePort } from "node:worker_threads";

export type Namespace = Record<string | symbol, unknown>;
export type HookFn<Exported extends object = Namespace, Result = unknown> = (
  exported: Exported,
  name: string,
  baseDir?: string,
) => Result;

export interface Hook<Exported extends object = Namespace> {
  unhook(): void;
}

export interface HookConstructor {
  new <Exported extends object = Namespace>(
    modules: readonly string[],
    hookFn: HookFn<Exported>,
  ): Hook<Exported>;
  <Exported extends object = Namespace>(
    modules: readonly string[],
    hookFn: HookFn<Exported>,
  ): Hook<Exported>;
}

export declare const Hook: HookConstructor;
export default Hook;

export type HookRegisterData = {
  addHookMessagePort: MessagePort;
  include: string[];
};

type CreateAddHookMessageChannelReturn = {
  addHookMessagePort: MessagePort;
  waitForAllMessagesAcknowledged: () => Promise<void>;
  registerOptions: {
    data: HookRegisterData;
    transferList: [MessagePort];
  };
};

export declare function createAddHookMessageChannel(): CreateAddHookMessageChannelReturn;
