import { v4 as uuidv4 } from "uuid";
import { SpanTypeAttribute, isObject } from "../../../util/index";
import { Attachment } from "../../logger";
import { INSTRUMENTATION_NAMES } from "../../span-origin";
import type {
  MCPProtocol,
  MCPRequest,
  MCPRequestHandler,
  MCPRequestHandlerExtra,
} from "../../vendor-sdk-types/mcp";
import {
  convertDataToBlob,
  getExtensionFromMediaType,
  isAutoCaptureAttachmentsEnabled,
} from "../../wrappers/attachment-utils";
import { BasePlugin } from "../core";
import { traceAsyncCall, unsubscribeAll } from "../core/tracing";
import {
  mcpChannels,
  mcpSDKChannels,
  mcpServerChannels,
  wrapMCPRequestHandler,
} from "./mcp-interceptors";

type MCPRequestParams = NonNullable<MCPRequest["params"]>;

type MCPRequestSpan = {
  type: SpanTypeAttribute;
  name: (params: MCPRequestParams) => string;
  input: (params: MCPRequestParams) => unknown;
  metadata?: (params: MCPRequestParams) => Record<string, unknown>;
  error?: (result: unknown) => unknown;
};

// Only requests that feed model context. Tool spans are named after the tool;
// prompt names and resource URIs stay in metadata to keep span names stable.
// A Map keeps untrusted method names away from prototype lookups.
const REQUEST_SPANS = new Map<string, MCPRequestSpan>([
  [
    "tools/call",
    {
      type: SpanTypeAttribute.TOOL,
      name: (params) =>
        typeof params.name === "string" && params.name
          ? params.name
          : "tools/call",
      input: (params) => params.arguments,
      error: extractToolError,
    },
  ],
  [
    "prompts/get",
    {
      type: SpanTypeAttribute.FUNCTION,
      name: () => "prompts/get",
      input: (params) => params.arguments,
      metadata: (params) =>
        typeof params.name === "string"
          ? { "mcp.prompt_name": params.name }
          : {},
    },
  ],
  [
    "resources/read",
    {
      type: SpanTypeAttribute.FUNCTION,
      name: () => "resources/read",
      input: (params) => ({ uri: params.uri }),
      metadata: (params) =>
        typeof params.uri === "string"
          ? { "mcp.resource_uri": params.uri }
          : {},
    },
  ],
]);

export class MCPPlugin extends BasePlugin {
  protected onEnable(): void {
    this.unsubscribers.push(
      ...[
        mcpSDKChannels.setRequestHandler,
        mcpServerChannels.setRequestHandler,
      ].map((channel) =>
        channel.intercept((target, receiver, args) => {
          // v1 passes `(schema, handler)` and v2 `(method, handler)`. v2 custom
          // methods pass `(method, schemas, handler)` and are never traced.
          const handler = args[1];
          if (typeof handler !== "function") {
            return Reflect.apply(target, receiver, args);
          }
          const wrappedArgs = [...args];
          wrappedArgs[1] = wrapMCPRequestHandler(
            handler as MCPRequestHandler,
            receiver as MCPProtocol,
          );
          return Reflect.apply(target, receiver, wrappedArgs);
        }),
      ),
      mcpChannels.requestHandler.intercept(
        (target, receiver, args, additional) => {
          const [request, extra] = args;
          const spanConfig =
            typeof request?.method === "string"
              ? REQUEST_SPANS.get(request.method)
              : undefined;
          if (!spanConfig) {
            return Reflect.apply(target, receiver, args);
          }
          const params = isObject(request.params) ? request.params : {};

          return traceAsyncCall<typeof mcpChannels.requestHandler>(
            () => Reflect.apply(target, receiver, args),
            { ...additional, arguments: args, self: receiver },
            {
              name: spanConfig.name(params),
              type: spanConfig.type,
              instrumentationName: INSTRUMENTATION_NAMES.MCP,
              extractInput: () => ({
                input: spanConfig.input(params),
                metadata: {
                  "mcp.method": request.method,
                  "mcp.session_id": getSessionId(extra, additional.protocol),
                  ...getRequestIdMetadata(extra),
                  ...spanConfig.metadata?.(params),
                },
              }),
              extractOutput: sanitizeResult,
              extractError: spanConfig.error,
              extractMetrics: () => ({}),
            },
          );
        },
      ),
    );
  }

  protected onDisable(): void {
    this.unsubscribers = unsubscribeAll(this.unsubscribers);
  }
}

const synthesizedSessionIds = new WeakMap<object, string>();

/**
 * Streamable HTTP sessions carry a transport session ID. Other transports
 * (stdio, in-memory) get a stable ID per connected transport so requests on
 * the same connection can still be correlated.
 */
function getSessionId(
  extra: MCPRequestHandlerExtra | undefined,
  protocol: MCPProtocol,
): string {
  if (typeof extra?.sessionId === "string" && extra.sessionId) {
    return extra.sessionId;
  }

  const connection = protocol.transport ?? protocol;
  let sessionId = synthesizedSessionIds.get(connection);
  if (!sessionId) {
    sessionId = uuidv4();
    synthesizedSessionIds.set(connection, sessionId);
  }
  return sessionId;
}

function getRequestIdMetadata(
  extra: MCPRequestHandlerExtra | undefined,
): Record<string, unknown> {
  const requestId = extra?.mcpReq?.id ?? extra?.requestId;
  return typeof requestId === "string" || typeof requestId === "number"
    ? { "mcp.request_id": requestId }
    : {};
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
  const { _meta: _, ...rest } = result;
  return sanitizeContent(rest, isAutoCaptureAttachmentsEnabled(), 0);
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
): unknown {
  if (depth >= 128) {
    return "<omitted>";
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeContent(item, captureAttachments, depth + 1),
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
    Object.entries(value).map(([key, item]) => [
      key,
      key === mediaKey
        ? toAttachment(
            item as string,
            value.mimeType,
            captureAttachments && value.type !== "audio",
          )
        : sanitizeContent(item, captureAttachments, depth + 1),
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
  return blob
    ? new Attachment({
        data: blob,
        filename: `${contentType.split("/")[0]}.${getExtensionFromMediaType(contentType)}`,
        contentType,
      })
    : data;
}
