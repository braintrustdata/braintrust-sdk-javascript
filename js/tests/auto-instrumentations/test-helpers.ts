/**
 * Test helpers for functional testing of instrumented code.
 */

import {
  newGlobalTracingChannel,
  type GlobalHookHandlers,
  type GlobalTracingChannel,
} from "../../src/global-instrumentation-hooks";

export interface CapturedEvent {
  arguments?: any[];
  self?: any;
  result?: any;
  error?: any;
  timestamp: number;
}

export interface EventCollector {
  start: CapturedEvent[];
  end: CapturedEvent[];
  asyncStart: CapturedEvent[];
  asyncEnd: CapturedEvent[];
  error: CapturedEvent[];
  clear: () => void;
  subscribe: (channelName: string) => void;
  unsubscribe: () => void;
}

/**
 * Creates an event collector for capturing global instrumentation hook events.
 */
export function createEventCollector(): EventCollector {
  const subscriptions: Array<{
    channel: GlobalTracingChannel;
    handlers: GlobalHookHandlers;
  }> = [];
  const collector: EventCollector = {
    start: [],
    end: [],
    asyncStart: [],
    asyncEnd: [],
    error: [],
    clear() {
      this.start = [];
      this.end = [];
      this.asyncStart = [];
      this.asyncEnd = [];
      this.error = [];
    },
    subscribe(channelName: string) {
      const channel = newGlobalTracingChannel(channelName);
      const handlers = {
        start: (ctx: any) => {
          this.start.push({
            arguments: ctx.arguments ? Array.from(ctx.arguments) : undefined,
            self: ctx.self,
            timestamp: Date.now(),
          });
        },
        end: (ctx: any) => {
          this.end.push({
            result: ctx.result,
            timestamp: Date.now(),
          });
        },
        asyncStart: (ctx: any) => {
          this.asyncStart.push({
            timestamp: Date.now(),
          });
        },
        asyncEnd: (ctx: any) => {
          this.asyncEnd.push({
            result: ctx.result,
            timestamp: Date.now(),
          });
        },
        error: (ctx: any) => {
          this.error.push({
            error: ctx.error,
            timestamp: Date.now(),
          });
        },
      };
      channel.subscribe(handlers);
      subscriptions.push({ channel, handlers });
    },
    unsubscribe() {
      for (const { channel, handlers } of subscriptions.splice(0)) {
        channel.unsubscribe(handlers);
      }
    },
  };

  return collector;
}

/**
 * Helper to run a function and wait for all events to be emitted.
 */
export async function runAndCollectEvents<T>(
  fn: () => T | Promise<T>,
  collector: EventCollector,
): Promise<T> {
  const result = await fn();
  // Give event handlers a chance to run
  await new Promise((resolve) => setImmediate(resolve));
  return result;
}
