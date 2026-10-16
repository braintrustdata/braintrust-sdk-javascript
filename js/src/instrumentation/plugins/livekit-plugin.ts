import type { LiveKitOptions } from "../livekit/options";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions -- receivers are private, version-pinned LiveKit hook boundaries. */
import type {
  AgentSession,
  ChatMessage,
  AudioFrame,
  EndOfTurnInfo,
} from "../livekit/types";
import { BasePlugin } from "../core";
import { livekitChannels } from "./livekit-channels";
import { runtime, observe, prepare } from "../livekit/runtime";
export class LiveKitPlugin extends BasePlugin {
  private started = false;
  private allowContent = true;
  constructor(private options: LiveKitOptions = {}) {
    super();
  }
  configure(options: LiveKitOptions) {
    if (this.started)
      throw new Error("Configure LiveKit before starting a session");
    this.options = options;
  }

  protected onEnable(): void {
    this.unsubscribers.push(
      livekitChannels.provider.intercept((target, self, args) => {
        const options = args[1] as { allowPii?: boolean } | undefined;
        this.allowContent = options?.allowPii ?? true;
        return Reflect.apply(target, self, args);
      }),
      livekitChannels.trace.intercept((target, self, args) => {
        observe(() => {
          const prepared = prepare(self, this.options, this.allowContent);
          this.started ||= prepared;
        });
        return Reflect.apply(target, self, args);
      }),
    );
    this.unsubscribers.push(
      livekitChannels.inference.intercept((target, self, args) => {
        const invoke = () => Reflect.apply(target, self, args);
        const rt = runtime();
        return rt ? rt.inference(invoke) : invoke();
      }),
    );
    for (const key of [
      "pipeline",
      "conversation",
      "userCompleted",
      "realtime",
      "start",
      "input",
      "output",
      "activity",
      "userTurn",
    ] as const) {
      this.unsubscribers.push(
        livekitChannels[key].intercept(
          (target: any, self: any, args: unknown[]): any => {
            observe(() => {
              const rt = runtime();
              if (key === "realtime") rt?.realtime(self, args[0] as any);
              if (key === "conversation")
                rt?.conversation(self, args[0] as ChatMessage);
              if (key === "start") rt?.begin(self);
              if (key === "input")
                rt?.input(self, args[0] as ReadableStream<AudioFrame>);
              if (key === "output") rt?.output(self);
              if (key === "activity") rt?.output(self.agentSession);
              if (key === "userTurn")
                rt?.userTurn(self, args[0] as EndOfTurnInfo);
            });
            const rt = runtime();
            if (
              rt &&
              (key === "userCompleted" ||
                key === "realtime" ||
                key === "pipeline")
            ) {
              const first = args[0] as any;
              return rt.scope(
                key === "userCompleted"
                  ? first?.userTurnSpan
                  : key === "pipeline"
                    ? first?.span
                    : first?.inferenceSpan,
                () => Reflect.apply(target, self, args),
              );
            }
            return Reflect.apply(target, self, args);
          },
        ),
      );
    }
    this.unsubscribers.push(
      livekitChannels.close.intercept(async (target, self, args) => {
        try {
          return await Reflect.apply(target, self, args);
        } finally {
          try {
            const rt = runtime();
            const finished = rt?.finish(self as AgentSession);
            if (rt?.automatic) await finished;
            else void finished?.catch(() => {});
          } catch {
            /* Keep shutdown usable. */
          }
        }
      }),
    );
  }
  protected onDisable(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }
}
