import { channel, defineChannels } from "../core";
import type {
  AISDKCallParams,
  AISDKResult,
} from "../../vendor-sdk-types/ai-sdk";

type AISDKStreamResult = AISDKResult | AsyncIterable<unknown>;

export const aiSDKChannels = defineChannels({
  generateText: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    Record<string, never>,
    unknown
  >({
    name: "generateText",
    fullName: "orchestrion:ai:generateText",
    kind: "async",
  }),
  streamText: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    Record<string, never>,
    unknown
  >({
    name: "streamText",
    fullName: "orchestrion:ai:streamText",
    kind: "async",
  }),
  generateObject: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    Record<string, never>,
    unknown
  >({
    name: "generateObject",
    fullName: "orchestrion:ai:generateObject",
    kind: "async",
  }),
  streamObject: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    Record<string, never>,
    unknown
  >({
    name: "streamObject",
    fullName: "orchestrion:ai:streamObject",
    kind: "async",
  }),
  agentGenerate: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    Record<string, never>,
    unknown
  >({
    name: "Agent.generate",
    fullName: "orchestrion:ai:Agent.generate",
    kind: "async",
  }),
  agentStream: channel<
    [AISDKCallParams],
    AISDKStreamResult,
    Record<string, never>,
    unknown
  >({
    name: "Agent.stream",
    fullName: "orchestrion:ai:Agent.stream",
    kind: "async",
  }),
});
