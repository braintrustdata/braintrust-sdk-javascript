import { channel, defineChannels } from "../core/channel-definitions";
import type {
  FlueCallHandle,
  FlueCallOptions,
  FlueContext,
  FlueEvent,
  FlueHarness,
  FlueOperationKind,
  FluePromptResponse,
  FlueSession,
  FlueSkillOptions,
  FlueTaskOptions,
} from "../../vendor-sdk-types/flue";

export const flueChannels = defineChannels("@flue/runtime", {
  createContext: channel<[unknown], FlueContext>({
    channelName: "createFlueContext",
    kind: "sync-stream",
  }),

  openSession: channel<
    [string | undefined, string | undefined, unknown],
    FlueSession,
    {
      harness?: FlueHarness;
    }
  >({
    channelName: "Harness.openSession",
    kind: "async",
  }),

  contextEvent: channel<
    [FlueEvent],
    void,
    {
      context?: FlueContext;
    }
  >({
    channelName: "context.event",
    kind: "sync-stream",
  }),

  prompt: channel<
    [string, FlueCallOptions | undefined],
    FluePromptResponse,
    {
      operation: FlueOperationKind;
      session?: FlueSession;
    }
  >({
    channelName: "session.prompt",
    kind: "async",
  }),

  skill: channel<
    [string, FlueSkillOptions | undefined],
    FluePromptResponse,
    {
      operation: FlueOperationKind;
      session?: FlueSession;
    }
  >({
    channelName: "session.skill",
    kind: "async",
  }),

  task: channel<
    [string, FlueTaskOptions | undefined],
    FluePromptResponse,
    {
      operation: FlueOperationKind;
      session?: FlueSession;
    }
  >({
    channelName: "session.task",
    kind: "async",
  }),

  compact: channel<
    [],
    void,
    {
      operation: FlueOperationKind;
      session?: FlueSession;
    }
  >({
    channelName: "session.compact",
    kind: "async",
  }),
});

export type FlueThenableResult = FlueCallHandle<unknown> | PromiseLike<unknown>;
