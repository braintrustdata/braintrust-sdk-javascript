import type { ChannelSpanInfo, SpanInfoCarrier, StartEvent } from "./types";
import { isObject, mergeDicts } from "../../util";

export type ChannelConfig = {
  name: string;
  shouldTrace?: (args: unknown[], event: unknown) => boolean;
  type: string;
};

function hasChannelSpanInfo(
  value: unknown,
): value is SpanInfoCarrier & { span_info: ChannelSpanInfo } {
  return isObject(value) && isObject(value.span_info);
}

function getChannelSpanInfo(
  event: StartEvent & SpanInfoCarrier,
): ChannelSpanInfo | undefined {
  if (isObject(event.span_info)) {
    return event.span_info;
  }

  const firstArg = event.arguments?.[0];
  if (hasChannelSpanInfo(firstArg)) {
    return firstArg.span_info;
  }

  return undefined;
}

export function buildStartSpanArgs(
  config: ChannelConfig,
  event: StartEvent & SpanInfoCarrier,
): {
  name: string;
  spanAttributes: Record<string, unknown>;
  spanInfoMetadata: Record<string, unknown> | undefined;
} {
  const spanInfo = getChannelSpanInfo(event);
  const spanAttributes: Record<string, unknown> = {
    type: config.type,
  };

  if (isObject(spanInfo?.spanAttributes)) {
    mergeDicts(spanAttributes, spanInfo.spanAttributes);
  }

  return {
    name:
      typeof spanInfo?.name === "string" && spanInfo.name
        ? spanInfo.name
        : config.name,
    spanAttributes,
    spanInfoMetadata: isObject(spanInfo?.metadata)
      ? spanInfo.metadata
      : undefined,
  };
}

export function mergeInputMetadata(
  metadata: unknown,
  spanInfoMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!spanInfoMetadata) {
    return isObject(metadata)
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (metadata as Record<string, unknown>)
      : undefined;
  }

  const mergedMetadata: Record<string, unknown> = {};
  mergeDicts(mergedMetadata, spanInfoMetadata);

  if (isObject(metadata)) {
    mergeDicts(mergedMetadata, metadata as Record<string, unknown>);
  }

  return mergedMetadata;
}
