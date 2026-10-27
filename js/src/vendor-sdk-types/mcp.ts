/**
 * Vendored subset of the Model Context Protocol TypeScript SDK types used by
 * the server instrumentation. Covers `@modelcontextprotocol/sdk` v1 and
 * `@modelcontextprotocol/server` v2, which share the `Protocol` request
 * handler registry.
 */

export type MCPRequest = {
  method: string;
  params?: {
    name?: unknown;
    arguments?: unknown;
    uri?: unknown;
    [key: string]: unknown;
  };
};

export type MCPRequestHandlerExtra = {
  sessionId?: string;
  /** v1 JSON-RPC request id. */
  requestId?: string | number;
  /** v2 request context. */
  mcpReq?: { id?: string | number };
  [key: string]: unknown;
};

export type MCPRequestHandler = (
  request: MCPRequest,
  extra: MCPRequestHandlerExtra,
) => unknown;

export type MCPProtocol = {
  /**
   * v1: `(requestSchema, handler)`. v2: `(method, handler)` or
   * `(method, schemas, handler)` for custom methods.
   */
  setRequestHandler: (...args: unknown[]) => void;
  readonly transport?: object;
  _requestHandlers?: Map<string, MCPRequestHandler>;
};
