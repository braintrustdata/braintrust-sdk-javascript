import type { Span } from "../../logger";
import { isObject } from "../../../util";
import type { RealtimeSession } from "./realtime";
import { modelFields } from "./schema";
import { observe } from "./runtime";

type Pending = { span?: Span; attributes?: Record<string, unknown> };

/** Joins native metrics and inference spans, regardless of arrival order. */
export class RealtimeMetrics {
  private pending = new Map<string, Pending>();
  private listener = (event: Record<string, unknown>) =>
    observe(() => {
      if (
        event.type !== "realtime_model_metrics" ||
        typeof event.requestId !== "string"
      )
        return;
      const input = isObject(event.inputTokenDetails)
        ? event.inputTokenDetails
        : {};
      const output = isObject(event.outputTokenDetails)
        ? event.outputTokenDetails
        : {};
      // Use LiveKit's native usage attribute spellings, including its compatibility
      // aliases, so early metrics produce the same trace as native OTel export.
      const attributes: Record<string, unknown> = {
        "gen_ai.response.id": event.requestId,
      };
      for (const [key, value] of Object.entries({
        "gen_ai.usage.input_tokens": event.inputTokens,
        "gen_ai.usage.output_tokens": event.outputTokens,
        "gen_ai.usage.cache_read.input_tokens": input.cachedTokens,
        "gen_ai.usage.input_cached_tokens": input.cachedTokens,
        "gen_ai.usage.text.input_tokens": input.textTokens,
        "gen_ai.usage.input_text_tokens": input.textTokens,
        "gen_ai.usage.audio.input_tokens": input.audioTokens,
        "gen_ai.usage.input_audio_tokens": input.audioTokens,
        "gen_ai.usage.text.output_tokens": output.textTokens,
        "gen_ai.usage.output_text_tokens": output.textTokens,
        "gen_ai.usage.audio.output_tokens": output.audioTokens,
        "gen_ai.usage.output_audio_tokens": output.audioTokens,
        "gen_ai.usage.reasoning.output_tokens": event.reasoningTokens,
        "gen_ai.usage.reasoning_tokens": event.reasoningTokens,
        "gen_ai.response.time_to_first_chunk":
          typeof event.ttftMs === "number" ? event.ttftMs / 1000 : undefined,
      })) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          attributes[key] = value;
      }
      this.match(event.requestId, { attributes });
    });

  constructor(private session: RealtimeSession) {
    session.on("metrics_collected", this.listener);
  }

  associate(responseId: string, span: Span) {
    this.match(responseId, { span });
  }

  private match(id: string, incoming: Pending) {
    const entry = { ...this.pending.get(id), ...incoming };
    if (entry.span && entry.attributes) {
      this.pending.delete(id);
      entry.span.log({
        metadata: entry.attributes,
        metrics: modelFields(entry.attributes).metrics,
      });
    } else {
      // Cancelled/discarded responses may never have a counterpart. Retain only
      // a bounded recent window, scoped to this realtime session.
      this.pending.set(id, entry);
      if (this.pending.size > 256)
        this.pending.delete(this.pending.keys().next().value!);
    }
  }

  close() {
    this.session.off("metrics_collected", this.listener);
    this.pending.clear();
  }
}
