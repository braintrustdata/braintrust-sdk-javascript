// Forked from import-in-the-middle@3.2.0. Modified by Braintrust.

export type Namespace = { [key: string]: any };
export type HookFn = (
  exported: Namespace,
  name: string,
  baseDir: string | void,
) => any;

export declare class Hook {
  constructor(modules: string[], hookFn: HookFn);
  unhook(): void;
}

export default Hook;

type CreateAddHookMessageChannelReturn<Data> = {
  addHookMessagePort: MessagePort;
  waitForAllMessagesAcknowledged: () => Promise<void>;
  registerOptions: { data?: Data; transferList?: any[] };
};

export declare function createAddHookMessageChannel<
  Data = any,
>(): CreateAddHookMessageChannelReturn<Data>;
