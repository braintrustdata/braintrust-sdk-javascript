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
import type { MCPIntegrationConfig } from "../config";
import { isAutoInstrumentationSuppressed } from "../auto-instrumentation-suppression";
import { observeResult, runInstrumentation } from "../core/observe-result";

type PendingRequest = {
  span: Span;
  transport: MCPTransport;
  id: string | number | symbol;
  message: object;
  captureContent: boolean;
  messageDone?: boolean;
  acknowledgementDone: boolean;
  handlerDone?: boolean;
  handlerFailure?: unknown;
  errorType?: string;
  method: string;
  ended: boolean;
  handlerStarted?: boolean;
  initialClient?: Record<string, string>;
  failure?: unknown;
};
const connections = new WeakMap<
  MCPTransport,
  Map<string | number | symbol, PendingRequest>
>();
const protocolVersions = new WeakMap<MCPTransport, string>();
const sessionIdentities = new WeakMap<
  MCPTransport,
  {
    sessionId: string;
    client?: Record<string, string>;
    server?: Record<string, string>;
  }
>();

function identity(
  info: unknown,
  side: "client" | "server",
): Record<string, string> {
  if (!isObject(info)) return {};
  const result: Record<string, string> = {};
  for (const key of ["name", "title", "version"]) {
    const value = info[key];
    if (typeof value === "string") result[`mcp.${side}.${key}`] = value;
  }
  return result;
}

function notificationContent(
  method: string,
  params: Record<string, unknown>,
): unknown {
  if (method === "notifications/cancelled") {
    const { reason: _reason, ...rest } = params;
    return sanitizeContent(rest, false, 0);
  }
  return sanitizeContent(params, false, 0);
}

function notificationMetadata(
  method: string,
  params: Record<string, unknown>,
  capture: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const put = (source: string, target: string, type: "string" | "number") => {
    const value = params[source];
    if (typeof value === type && (type !== "number" || Number.isFinite(value)))
      result[target] = value;
  };
  if (method === "notifications/cancelled") {
    if (
      typeof params.requestId === "string" ||
      typeof params.requestId === "number"
    )
      result["mcp.cancelled.request_id"] = String(params.requestId);
  } else if (method === "notifications/progress") {
    if (
      typeof params.progressToken === "string" ||
      typeof params.progressToken === "number"
    )
      result["mcp.progress.token"] = String(params.progressToken);
    put("progress", "mcp.progress.current", "number");
    put("total", "mcp.progress.total", "number");
    if (
      typeof params.progress === "number" &&
      Number.isFinite(params.progress) &&
      typeof params.total === "number" &&
      Number.isFinite(params.total) &&
      params.total > 0
    )
      result["mcp.progress.percentage"] =
        (params.progress / params.total) * 100;
    if (capture) put("message", "mcp.progress.message", "string");
  } else if (method === "notifications/message") {
    put("level", "mcp.logging.level", "string");
    put("logger", "mcp.logging.logger", "string");
    if (params.data !== undefined) {
      result["mcp.logging.data_type"] = typeof params.data;
      if (capture) result["mcp.logging.message"] = params.data;
    }
  } else if (
    method === "notifications/resources/updated" &&
    typeof params.uri === "string"
  ) {
    result["mcp.resource.uri"] = params.uri;
    try {
      result["mcp.resource.protocol"] = new URL(params.uri).protocol.slice(
        0,
        -1,
      );
    } catch {
      /* relative URI */
    }
  } else if (method === "notifications/initialized") {
    result["mcp.lifecycle.phase"] = "initialization_complete";
    result["mcp.protocol.ready"] = 1;
  }
  return result;
}
let requestContext: IsoAsyncLocalStorage<PendingRequest> | undefined;

let httpContext:
  | IsoAsyncLocalStorage<{
      transport: MCPTransport;
      metadata: Record<string, string | number>;
      notifications: Set<PendingRequest>;
      done: boolean;
    }>
  | undefined;

export function traceMCPHttpRequest<T>(
  call: () => T,
  transport: MCPTransport,
  request: unknown,
): T {
  const metadata: Record<string, string | number> = {
    "network.protocol.name": "http",
  };
  if (isObject(request)) {
    if (typeof request.httpVersion === "string") {
      metadata["network.protocol.version"] = request.httpVersion;
      metadata["network.transport"] = request.httpVersion.startsWith("3")
        ? "quic"
        : "tcp";
    }
    if (
      isObject(request.socket) &&
      typeof request.socket.remoteAddress === "string"
    ) {
      metadata["client.address"] = request.socket.remoteAddress;
      if (typeof request.socket.remotePort === "number")
        metadata["client.port"] = request.socket.remotePort;
    }
  }
  httpContext ??= iso.newAsyncLocalStorage();
  const context = {
    transport,
    metadata,
    notifications: new Set<PendingRequest>(),
    done: false,
  };
  const settled = (error?: unknown) => {
    context.done = true;
    for (const notification of context.notifications) {
      notification.acknowledgementDone = true;
      if (
        error !== undefined ||
        (notification.messageDone && notification.handlerDone)
      ) {
        finish(notification, error);
      }
    }
    context.notifications.clear();
  };
  return httpContext.run(context, () => {
    try {
      return observeResult(call(), () => settled(), settled);
    } catch (error) {
      settled(error);
      throw error;
    }
  });
}

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
  const failure = request.failure ?? error ?? request.handlerFailure;
  request.span.log({
    ...(failure !== undefined ? { error: failure } : {}),
    metadata: {
      ...(failure !== undefined
        ? {
            "error.type":
              request.errorType ??
              (failure instanceof Error ? failure.constructor.name : "_OTHER"),
          }
        : {}),
      ...(cancelled ? { "mcp.cancelled": true } : {}),
    },
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
    metadata["mcp.protocol.version"] =
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
  config: MCPIntegrationConfig = {},
): T {
  const request = runInstrumentation(() => {
    if (
      isAutoInstrumentationSuppressed() ||
      !isObject(message) ||
      typeof message.method !== "string" ||
      (message.id !== undefined &&
        typeof message.id !== "string" &&
        typeof message.id !== "number")
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
      active.message === message
    )
      return;
    const method = message.method;
    const id = message.id === undefined ? Symbol("notification") : message.id;
    const protocolVersion = protocolVersions.get(transport);
    const session =
      transport.sessionId &&
      sessionIdentities.get(transport)?.sessionId === transport.sessionId
        ? sessionIdentities.get(transport)
        : undefined;
    if (method === "initialize" && transport.sessionId) {
      sessionIdentities.set(transport, {
        sessionId: transport.sessionId,
        client: identity(params.clientInfo, "client"),
      });
    }
    const http = httpContext?.getStore();
    // Only known SDK transports identify a transport here. HTTP details exposed
    // by Node are collected separately around handleRequest, never from headers.
    const transportName = transport.constructor.name;
    const metadata = {
      "mcp.method.name": method,
      ...(typeof id !== "symbol" ? { "jsonrpc.request.id": String(id) } : {}),
      ...(transport.sessionId ? { "mcp.session.id": transport.sessionId } : {}),
      ...(typeof id !== "symbol" && method === "tools/call"
        ? {
            "gen_ai.operation.name": "execute_tool",
            ...(typeof params.name === "string"
              ? { "gen_ai.tool.name": params.name }
              : {}),
          }
        : {}),
      ...(typeof id !== "symbol" &&
      method === "prompts/get" &&
      typeof params.name === "string"
        ? { "gen_ai.prompt.name": params.name }
        : {}),
      ...([
        "resources/read",
        "resources/subscribe",
        "resources/unsubscribe",
        "notifications/resources/updated",
      ].includes(method) && typeof params.uri === "string"
        ? { "mcp.resource.uri": params.uri }
        : {}),
      ...(protocolVersion ? { "mcp.protocol.version": protocolVersion } : {}),
      ...(typeof message.jsonrpc === "string" && message.jsonrpc !== "2.0"
        ? { "jsonrpc.protocol.version": message.jsonrpc }
        : {}),
      ...(transportName === "StdioServerTransport"
        ? { "network.transport": "pipe" }
        : {}),
      ...([
        "StreamableHTTPServerTransport",
        "WebStandardStreamableHTTPServerTransport",
        "SSEServerTransport",
      ].includes(transportName)
        ? { "network.protocol.name": "http" }
        : {}),
      ...(transportName === "WebSocketServerTransport"
        ? { "network.protocol.name": "websocket" }
        : {}),
      ...(http?.transport === transport ? http.metadata : {}),
      ...(session?.client ?? {}),
      ...(session?.server ?? {}),
      ...(method === "initialize" ? identity(params.clientInfo, "client") : {}),
      ...(method === "initialize" && typeof params.protocolVersion === "string"
        ? { "mcp.protocol.version": params.protocolVersion }
        : {}),
      ...(method === "tools/call" && typeof params.tool_call_id === "string"
        ? { "gen_ai.tool.call.id": params.tool_call_id }
        : {}),
      ...(typeof id === "symbol"
        ? {
            "mcp.notification.direction": "incoming",
            ...notificationMetadata(
              method,
              params,
              config.captureContent !== false,
            ),
          }
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
          typeof id !== "symbol" &&
          (method === "tools/call" || method === "prompts/get") &&
          typeof params.name === "string" &&
          params.name
            ? `${method} ${params.name}`
            : method,
        type:
          typeof id !== "symbol" && method === "tools/call"
            ? SpanTypeAttribute.TOOL
            : SpanTypeAttribute.FUNCTION,
        // An explicit empty parent also prevents inheriting withParent context.
        parent: parent ?? "",
        event: {
          metadata,
          ...(config.captureContent !== false && typeof id === "symbol"
            ? { input: notificationContent(method, params) }
            : {}),
          ...(config.captureContent !== false && typeof id !== "symbol"
            ? method === "tools/call" || method === "prompts/get"
              ? { input: params.arguments }
              : method === "resources/read" && params.uri !== undefined
                ? { input: { uri: params.uri } }
                : {}
            : {}),
        },
      },
      INSTRUMENTATION_NAMES.MCP,
    );
    const span = withCurrent(NOOP_SPAN, () => startSpan(spanArgs));
    const state: PendingRequest = {
      span,
      transport,
      id,
      message,
      captureContent: config.captureContent !== false,
      acknowledgementDone: http?.transport !== transport || http.done,
      method,
      ...(method === "initialize"
        ? { initialClient: identity(params.clientInfo, "client") }
        : {}),
      ended: false,
    };
    pending.set(id, state);
    if (typeof id === "symbol" && http?.transport === transport && !http.done) {
      http.notifications.add(state);
    }
    return state;
  });
  if (!request) return call();
  requestContext ??= iso.newAsyncLocalStorage<PendingRequest>();
  return requestContext.run(request, () =>
    withCurrent(request.span, () => {
      try {
        return observeResult(
          call(),
          () => {
            request.messageDone = true;
            if (typeof request.id === "symbol") {
              // MCP dispatches notification handlers in a microtask. Observe
              // after that dispatch, including notifications with no handler.
              void Promise.resolve().then(() => {
                if (!request.handlerStarted) request.handlerDone = true;
                if (request.handlerDone && request.acknowledgementDone)
                  finish(request);
              });
            }
          },
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
  options?: unknown,
  config: MCPIntegrationConfig = {},
): T {
  if (
    isObject(message) &&
    typeof message.method === "string" &&
    message.id === undefined
  ) {
    return traceMCPOutgoingNotification(
      call,
      transport,
      message,
      options,
      config,
    );
  }
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
        const code = message.error.code;
        state.span.log({
          metadata: { "rpc.response.status_code": String(code) },
        });
        // The response classifies the outcome; a caught validation exception
        // from a handler is not an independent server failure.
        state.handlerFailure = undefined;
        if (
          !(
            typeof code === "number" &&
            [-32700, -32600, -32601, -32602, -32002].includes(code)
          )
        ) {
          state.failure = new Error(
            `MCP error ${code}: ${message.error.message}`,
          );
          state.errorType = String(code);
        }
      } else if ("result" in message) {
        const result = message.result;
        if (
          state.method === "initialize" &&
          isObject(result) &&
          typeof result.protocolVersion === "string"
        ) {
          protocolVersions.set(transport, result.protocolVersion);
          if (transport.sessionId) {
            const prior = sessionIdentities.get(transport);
            sessionIdentities.set(transport, {
              sessionId: transport.sessionId,
              ...(prior?.sessionId === transport.sessionId ? prior : {}),
              client: state.initialClient ?? prior?.client,
              server: identity(result.serverInfo, "server"),
            });
          }
          state.span.log({
            metadata: { "mcp.protocol.version": result.protocolVersion },
          });
        }
        state.span.log({
          metadata: {
            ...(state.method === "initialize" && isObject(result)
              ? identity(result.serverInfo, "server")
              : {}),
            ...protocolMetadata(
              isObject(result) ? result._meta : undefined,
              "response",
            ),
          },
          ...(state.captureContent &&
          ["tools/call", "prompts/get", "resources/read"].includes(state.method)
            ? { output: sanitizeResult(result) }
            : {}),
        });
        if (
          state.method === "tools/call" &&
          isObject(result) &&
          result.isError === true
        ) {
          state.failure ??= extractToolError(result, state.captureContent);
          state.errorType ??= "tool_error";
        }
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

function traceMCPOutgoingNotification<T>(
  call: () => T,
  transport: MCPTransport,
  message: Record<string, unknown>,
  options: unknown,
  config: MCPIntegrationConfig,
): T {
  if (isAutoInstrumentationSuppressed()) return call();
  const span = runInstrumentation(() => {
    const method = message.method as string;
    const params = isObject(message.params) ? message.params : {};
    const relatedId = isObject(options) ? options.relatedRequestId : undefined;
    const related =
      typeof relatedId === "string" || typeof relatedId === "number"
        ? connections.get(transport)?.get(relatedId)
        : undefined;
    const meta = isObject(params._meta) ? params._meta : {};
    const carrier: Record<string, string> = {};
    for (const key of ["traceparent", "tracestate", "baggage"]) {
      const value = meta[key];
      if (typeof value === "string") carrier[key] = value;
    }
    const parent = extractTraceContextFromHeaders(carrier);
    const metadata = {
      "mcp.method.name": method,
      "mcp.notification.direction": "outgoing",
      ...(transport.sessionId ? { "mcp.session.id": transport.sessionId } : {}),
      ...notificationMetadata(method, params, config.captureContent !== false),
    };
    return withCurrent(related?.span ?? NOOP_SPAN, () =>
      startSpan(
        withSpanInstrumentationName(
          {
            name: method,
            type: SpanTypeAttribute.FUNCTION,
            ...(parent ? { parent } : related ? {} : { parent: "" }),
            event: {
              metadata,
              ...(config.captureContent !== false
                ? { output: notificationContent(method, params) }
                : {}),
            },
          },
          INSTRUMENTATION_NAMES.MCP,
        ),
      ),
    );
  });
  if (!span) return call();
  const finishNotification = (error?: unknown) => {
    if (error !== undefined)
      span.log({
        error,
        metadata: {
          "error.type":
            error instanceof Error ? error.constructor.name : "_OTHER",
        },
      });
    span.end();
  };
  try {
    return observeResult(
      call(),
      () => finishNotification(),
      finishNotification,
    );
  } catch (error) {
    finishNotification(error);
    throw error;
  }
}

export function traceMCPTransportError<T>(
  call: () => T,
  transport: MCPTransport,
  error: unknown,
): T {
  for (const request of connections.get(transport)?.values() ?? [])
    finish(request, error);
  return call();
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
    else if (error !== undefined) state.handlerFailure ??= error;
  };
  try {
    return observeResult(
      call(),
      (result) => {
        if (
          !state.ended &&
          !signal?.aborted &&
          state.method === "tools/call" &&
          isObject(result) &&
          result.isError === true
        ) {
          state.failure ??= extractToolError(result, state.captureContent);
          state.errorType ??= "tool_error";
        }
        settled();
      },
      (error) => settled(error),
    );
  } catch (error) {
    settled(error);
    throw error;
  }
}

/** Observe the actual handler promise; transport dispatch often returns void. */
export function traceMCPNotificationHandler<T>(
  call: () => T,
  protocol: MCPProtocol,
): T {
  const state = requestContext?.getStore();
  if (
    !state ||
    state.ended ||
    typeof state.id !== "symbol" ||
    state.transport !== protocol.transport
  )
    return call();
  state.handlerStarted = true;
  const settled = (error?: unknown) => {
    state.handlerDone = true;
    state.failure ??= error;
    if (state.messageDone && state.acknowledgementDone) finish(state);
  };
  try {
    return observeResult(call(), () => settled(), settled);
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
  protocolVersions.delete(transport);
  sessionIdentities.delete(transport);
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

function extractToolError(result: unknown, captureContent: boolean): unknown {
  if (!isObject(result) || result.isError !== true) {
    return undefined;
  }

  const text =
    captureContent && Array.isArray(result.content)
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
