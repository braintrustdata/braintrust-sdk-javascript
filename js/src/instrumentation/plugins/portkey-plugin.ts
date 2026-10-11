import { BasePlugin } from "../core";
import { traceStreamingChannel, unsubscribeAll } from "../core/channel-tracing";
import { SpanTypeAttribute } from "../../../util/index";
import { parseMetricsFromUsage } from "../../openai-utils";
import { getCurrentUnixTimestamp } from "../../util";
import { aggregateChatCompletionChunks } from "./openai-plugin";
import { extractOpenAIChatInput } from "./openai-span-data";
import { portkeyChannels } from "./portkey-channels";

export class PortkeyPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      traceStreamingChannel(portkeyChannels.chatCompletionsCreate, {
        name: "portkey.chat.completions.create",
        type: SpanTypeAttribute.LLM,
        extractInput: ([params]) => {
          const { input, metadata } = extractOpenAIChatInput(params);
          return { input, metadata: { ...metadata, provider: "portkey" } };
        },
        extractOutput: (result) => result?.choices,
        extractMetrics: (result, startTime) => {
          const metrics = parseMetricsFromUsage(result?.usage);
          if (startTime) {
            metrics.time_to_first_token = getCurrentUnixTimestamp() - startTime;
          }
          return metrics;
        },
        aggregateChunks: aggregateChatCompletionChunks,
      }),
    );
  }

  protected onDisable(): void {
    unsubscribeAll(this.unsubscribers);
  }
}
