import { v4 as uuidv4 } from "uuid";
import { automaticAttachmentOriginals } from "../../automatic-attachments";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import iso, { type IsoAsyncLocalStorage } from "../../isomorph";
import {
  Attachment,
  NOOP_SPAN,
  extractTraceContextFromHeaders,
  startSpan,
  withCurrent,
  type Span,
} from "../../logger";
import {
  INSTRUMENTATION_NAMES,
  withSpanInstrumentationName,
} from "../../span-origin";
import type {
  MCPTransport,
  MCPRequest,
  MCPRequestHandlerExtra,
  MCPProtocol,
} from "../../vendor-sdk-types/mcp";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  isAutoCaptureAttachmentsEnabled,
} from "../../wrappers/attachment-utils";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { observeResult, runInstrumentation } from "../core/observe-result";

type PendingRequest = {
  span: Span;
  transport: MCPTransport;
  id: string | number;
  method: string;
  ended: boolean;
  handlerStarted?: boolean;
  failure?: unknown;
};
const connections = new WeakMap<
  MCPTransport,
  Map<string | number, PendingRequest>
>();
const sessionIds = new WeakMap<MCPTransport, string>();
let requestContext: IsoAsyncLocalStorage<PendingRequest> | undefined;

function finish(
  request: PendingRequest,
  error?: unknown,
  cancelled = false,
): void {
  if (request.ended) return;
  request.ended = true;
  if (connections.get(request.transport)?.get(request.id) === request) {
    connections.get(request.transport)!.delete(request.id);
  }
  const failure = request.failure ?? error;
  request.span.log({
    ...(failure !== undefined ? { error: failure } : {}),
    ...(cancelled ? { metadata: { "mcp.cancelled": true } } : {}),
  });
  request.span.end();
}

function protocolMetadata(
  meta: unknown,
  direction: "request" | "response",
): Record<string, string> {
  if (!isObject(meta)) return {};
  const metadata: Record<string, string> = {};
  if (
    direction === "request" &&
    typeof meta["io.modelcontextprotocol/protocolVersion"] === "string"
  ) {
    metadata["mcp.protocol_version"] =
      meta["io.modelcontextprotocol/protocolVersion"];
  }
  const side = direction === "request" ? "client" : "server";
  const info = meta[`io.modelcontextprotocol/${side}Info`];
  if (isObject(info)) {
    for (const key of ["name", "title", "version"]) {
      const value = info[key];
      if (typeof value === "string") metadata[`mcp.${side}.${key}`] = value;
    }
  }
  return metadata;
}

/** Observe transport receipt, before protocol validation and dispatch. */
export function traceMCPMessage<T>(
  call: () => T,
  transport: MCPTransport,
  message: unknown,
): T {
  const request = runInstrumentation(() => {
    if (
      isAutoInstrumentationSuppressed() ||
      !isObject(message) ||
      typeof message.method !== "string" ||
      (typeof message.id !== "string" && typeof message.id !== "number")
    )
      return;
    const params = isObject(message.params) ? message.params : {};
    const meta = isObject(params._meta) ? params._meta : {};
    // Task submission/polling has a separate result lifecycle and is excluded.
    if (
      message.method.startsWith("tasks/") ||
      params.task !== undefined ||
      meta["io.modelcontextprotocol/related-task"] !== undefined
    )
      return;
    let pending = connections.get(transport);
    if (!pending) connections.set(transport, (pending = new Map()));
    // Multiple instrumentation layers can see the same delivery.
    const active = requestContext?.getStore();
    if (
      active &&
      !active.ended &&
      active.transport === transport &&
      active.id === message.id
    )
      return;
    let sessionId = transport.sessionId || sessionIds.get(transport);
    if (!sessionId) sessionIds.set(transport, (sessionId = uuidv4()));
    const method = message.method;
    const metadata = {
      "mcp.method": method,
      "mcp.request_id": message.id,
      "mcp.session_id": sessionId,
      ...(method === "prompts/get" && typeof params.name === "string"
        ? { "mcp.prompt_name": params.name }
        : {}),
      ...(method === "resources/read" && typeof params.uri === "string"
        ? { "mcp.resource_uri": params.uri }
        : {}),
      ...protocolMetadata(meta, "request"),
    };
    const carrier: Record<string, string> = {};
    for (const key of ["traceparent", "tracestate", "baggage"]) {
      const value = meta[key];
      if (typeof value === "string") carrier[key] = value;
    }
    const parent = extractTraceContextFromHeaders(carrier);
    const spanArgs = withSpanInstrumentationName(
      {
        name:
          method === "tools/call" &&
          typeof params.name === "string" &&
          params.name
            ? params.name
            : method,
        type:
          method === "tools/call"
            ? SpanTypeAttribute.TOOL
            : SpanTypeAttribute.FUNCTION,
        parent,
        event: {
          metadata,
          ...(method === "tools/call" || method === "prompts/get"
            ? { input: params.arguments }
            : method === "resources/read" && params.uri !== undefined
              ? { input: { uri: params.uri } }
              : {}),
        },
      },
      INSTRUMENTATION_NAMES.MCP,
    );
    const span = parent
      ? withCurrent(NOOP_SPAN, () => startSpan(spanArgs))
      : startSpan(spanArgs);
    const state: PendingRequest = {
      span,
      transport,
      id: message.id,
      method,
      ended: false,
    };
    pending.set(message.id, state);
    return state;
  });
  if (!request) return call();
  requestContext ??= iso.newAsyncLocalStorage<PendingRequest>();
  return requestContext.run(request, () =>
    withCurrent(request.span, () => {
      try {
        return observeResult(
          call(),
          () => {},
          (error) => finish(request, error),
        );
      } catch (error) {
        finish(request, error);
        throw error;
      }
    }),
  );
}

/** Keep requests open until the response send settles, preserving its promise. */
export function traceMCPSend<T>(
  call: () => T,
  transport: MCPTransport,
  message: unknown,
): T {
  const request = runInstrumentation(() => {
    if (
      !isObject(message) ||
      typeof message.method === "string" ||
      (typeof message.id !== "string" && typeof message.id !== "number")
    )
      return;
    const active = requestContext?.getStore();
    const state =
      active?.transport === transport && active.id === message.id
        ? active
        : connections.get(transport)?.get(message.id);
    if (!state || state.ended) return;
    runInstrumentation(() => {
      if (isObject(message.error)) {
        state.failure ??= new Error(
          `MCP error ${message.error.code}: ${message.error.message}`,
        );
      } else if ("result" in message) {
        const result = message.result;
        state.span.log({
          metadata: protocolMetadata(
            isObject(result) ? result._meta : undefined,
            "response",
          ),
          ...(["tools/call", "prompts/get", "resources/read"].includes(
            state.method,
          )
            ? { output: sanitizeResult(result) }
            : {}),
        });
        if (state.method === "tools/call")
          state.failure ??= extractToolError(result);
      }
    });
    return state;
  });
  if (!request) return call();
  try {
    return observeResult(
      call(),
      () => finish(request),
      (error) => finish(request, error),
    );
  } catch (error) {
    finish(request, error);
    throw error;
  }
}

/** Handler settlement observes cancellation; it never starts another span. */
export function traceMCPHandler<T>(
  call: () => T,
  protocol: MCPProtocol,
  request: MCPRequest,
  extra: MCPRequestHandlerExtra,
): T {
  const active = requestContext?.getStore();
  const id = extra?.mcpReq?.id ?? extra?.requestId ?? request.id;
  const state =
    active && active.transport === protocol.transport && active.id === id
      ? active
      : undefined;
  if (!state || state.ended) return call();
  state.handlerStarted = true;
  const signal = extra?.mcpReq?.signal ?? extra?.signal;
  const settled = (error?: unknown) => {
    if (state.ended) return;
    if (signal?.aborted) finish(state, undefined, true);
    else if (error !== undefined) state.failure ??= error;
  };
  try {
    return observeResult(
      call(),
      (result) => {
        if (!state.ended && !signal?.aborted && state.method === "tools/call")
          state.failure ??= extractToolError(result);
        settled();
      },
      (error) => settled(error),
    );
  } catch (error) {
    settled(error);
    throw error;
  }
}

export function traceMCPClose<T>(call: () => T, transport: MCPTransport): T {
  for (const request of connections.get(transport)?.values() ?? []) {
    finish(
      request,
      new Error("MCP connection closed before the response completed"),
    );
  }
  connections.delete(transport);
  sessionIds.delete(transport);
  return call();
}

export function traceMCPProtocolError<T>(call: () => T, error: unknown): T {
  const request = requestContext?.getStore();
  if (request && !request.ended) {
    request.failure ??= error;
    // Encoding errors after a handler are followed by an error response.
    // Dispatch drops reported before any handler have no response to wait for.
    if (!request.handlerStarted) finish(request);
  }
  return call();
}

function extractToolError(result: unknown): unknown {
  if (!isObject(result) || result.isError !== true) {
    return undefined;
  }

  const text = Array.isArray(result.content)
    ? result.content
        .flatMap((block) =>
          isObject(block) &&
          block.type === "text" &&
          typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n")
    : "";
  return text || "Tool returned an error result";
}

function sanitizeResult(result: unknown): unknown {
  if (!isObject(result)) {
    return result;
  }
  return sanitizeContent(result, isAutoCaptureAttachmentsEnabled(), 0);
}

/**
 * Replace inline base64 media in MCP content blocks and resource contents.
 * Images and resource blobs become attachments only when attachment capture
 * is enabled. Audio and video bytes are never captured.
 */
function sanitizeContent(
  value: unknown,
  captureAttachments: boolean,
  depth: number,
  protocolContent = true,
): unknown {
  if (depth >= 128) {
    return "<omitted>";
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeContent(item, captureAttachments, depth + 1, protocolContent),
    );
  }
  if (!isObject(value)) {
    return value;
  }

  const mediaKey =
    (value.type === "image" || value.type === "audio") &&
    typeof value.data === "string"
      ? "data"
      : typeof value.uri === "string" && typeof value.blob === "string"
        ? "blob"
        : undefined;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !protocolContent || key !== "_meta")
      .map(([key, item]) => [
        key,
        key === mediaKey
          ? toAttachment(
              item as string,
              value.mimeType,
              captureAttachments && value.type !== "audio",
            )
          : sanitizeContent(
              item,
              captureAttachments,
              depth + 1,
              protocolContent && key !== "structuredContent",
            ),
      ]),
  );
}

function toAttachment(
  data: string,
  mimeType: unknown,
  captureAttachments: boolean,
): Attachment | string {
  // Values that cannot be decoded stay unchanged when capture is enabled.
  const contentType =
    typeof mimeType === "string" && mimeType
      ? mimeType
      : "application/octet-stream";
  if (
    !captureAttachments ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/")
  ) {
    return "<omitted>";
  }

  const blob = convertDataToBlob(data, contentType);
  if (!blob) return data;
  const attachment = new Attachment({
    data: blob,
    filename: `${contentType.split("/")[0]}.${getExtensionFromMediaType(contentType)}`,
    contentType,
  });
  automaticAttachmentOriginals.set(attachment, data);
  return attachment;
}
