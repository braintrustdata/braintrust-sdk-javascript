import { BasePlugin } from "../core";
import type { ChannelMessage } from "../core/channel-definitions";
import type { IsoChannelHandlers, IsoTracingChannel } from "../../isomorph";
import type { LangChainCallbackManager } from "../../vendor-sdk-types/langchain";
import {
  BRAINTRUST_LANGCHAIN_CALLBACK_HANDLER_NAME,
  BraintrustLangChainCallbackHandler,
} from "./langchain-callback-handler";
import { langChainChannels } from "./langchain-channels";

type LangChainConfigureChannel =
  | typeof langChainChannels.configure
  | typeof langChainChannels.configureSync;

export class LangChainPlugin extends BasePlugin {
  private injectedManagers = new WeakSet<object>();

  protected onEnable(): void {
    this.subscribeToConfigure(langChainChannels.configure);
    this.subscribeToConfigure(langChainChannels.configureSync);
  }

  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers = [];
    this.injectedManagers = new WeakSet<object>();
  }

  private subscribeToConfigure(channel: LangChainConfigureChannel): void {
    const tracingChannel = channel.tracingChannel() as IsoTracingChannel<
      ChannelMessage<LangChainConfigureChannel>
    >;

    const handlers: IsoChannelHandlers<
      ChannelMessage<LangChainConfigureChannel>
    > = {
      start: (event) => {
        injectHandlerIntoArguments(event.arguments);
      },
      end: (event) => {
        this.injectHandler(event.result);
      },
    };

    tracingChannel.subscribe(handlers);
    this.unsubscribers.push(() => {
      tracingChannel.unsubscribe(handlers);
    });
  }

  private injectHandler(result: unknown): void {
    if (!isCallbackManager(result)) {
      return;
    }

    if (this.injectedManagers.has(result) || hasBraintrustHandler(result)) {
      return;
    }

    try {
      result.addHandler(new BraintrustLangChainCallbackHandler(), true);
      this.injectedManagers.add(result);
    } catch {
      // Instrumentation must never break LangChain user code.
    }
  }
}

function isCallbackManager(value: unknown): value is LangChainCallbackManager &
  object & {
    addHandler: (handler: unknown, inherit?: boolean) => void;
  } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const maybeManager = value as LangChainCallbackManager;
  return typeof maybeManager.addHandler === "function";
}

function hasBraintrustHandler(manager: LangChainCallbackManager): boolean {
  return (
    manager.handlers?.some((handler) => {
      if (typeof handler !== "object" || handler === null) {
        return false;
      }
      const name = Reflect.get(handler, "name");
      return name === BRAINTRUST_LANGCHAIN_CALLBACK_HANDLER_NAME;
    }) ?? false
  );
}

function injectHandlerIntoArguments(args: ArrayLike<unknown>): void {
  if (!isWritableArgumentsObject(args)) {
    return;
  }

  const inheritedHandlers = Reflect.get(args, "0");
  const handler = new BraintrustLangChainCallbackHandler();

  if (inheritedHandlers === undefined || inheritedHandlers === null) {
    Reflect.set(args, "0", [handler]);
    return;
  }

  if (Array.isArray(inheritedHandlers)) {
    if (!inheritedHandlers.some(isBraintrustHandler)) {
      inheritedHandlers.push(handler);
    }
  }
}

function isWritableArgumentsObject(
  args: ArrayLike<unknown>,
): args is ArrayLike<unknown> & object {
  return typeof args === "object" && args !== null;
}

function isBraintrustHandler(handler: unknown): boolean {
  if (typeof handler !== "object" || handler === null) {
    return false;
  }
  return (
    Reflect.get(handler, "name") === BRAINTRUST_LANGCHAIN_CALLBACK_HANDLER_NAME
  );
}
