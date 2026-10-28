/** Vendored transport/protocol subset shared by MCP TypeScript SDK v1 and v2. */
export type MCPRequest = {
  id?: string | number;
  method: string;
  params?: {
    name?: unknown;
    arguments?: unknown;
    uri?: unknown;
    _meta?: unknown;
    [key: string]: unknown;
  };
};

export type MCPRequestHandlerExtra = {
  sessionId?: string;
  requestId?: string | number;
  signal?: AbortSignal;
  mcpReq?: { id?: string | number; signal?: AbortSignal };
  [key: string]: unknown;
};

export type MCPRequestHandler = (
  request: MCPRequest,
  extra: MCPRequestHandlerExtra,
) => unknown;

export type MCPNotificationHandler = (
  notification: MCPRequest,
  ...args: unknown[]
) => unknown;

export type MCPTransport = {
  sessionId?: string;
  start: (...args: unknown[]) => unknown;
  send: (message: unknown, ...args: unknown[]) => unknown;
  onmessage?: (message: unknown, ...args: unknown[]) => unknown;
  onclose?: (...args: unknown[]) => unknown;
};

export type MCPProtocol = {
  connect: (transport: MCPTransport, ...args: unknown[]) => unknown;
  setRequestHandler: (...args: unknown[]) => void;
  setNotificationHandler?: (...args: unknown[]) => void;
  readonly transport?: MCPTransport;
  fallbackRequestHandler?: MCPRequestHandler;
  fallbackNotificationHandler?: MCPNotificationHandler;
  _serverInfo?: unknown;
  _requestHandlers?: Map<string, MCPRequestHandler>;
  _notificationHandlers?: Map<string, MCPNotificationHandler>;
  _onerror?: (error: unknown) => unknown;
};
