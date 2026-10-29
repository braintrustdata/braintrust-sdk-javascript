import { debugLogger } from "../debug-logger";
import { fastMCPChannels } from "../instrumentation/plugins/fastmcp-interceptors";
import type {
  FastMCPModule,
  FastMCPSession,
} from "../vendor-sdk-types/fastmcp";

const wrapped = Symbol.for("braintrust.fastmcp.connect-wrapper");

/**
 * Trace FastMCP 3.35+ and 4.x servers with Braintrust.
 * Wrap the module before starting servers. This installs an idempotent session
 * hook for all servers created by that module, including stateless HTTP requests.
 * Content capture is controlled by `integrations.fastmcp.captureContent`.
 *
 * @example
 * ```ts
 * import * as fastmcp from "fastmcp";
 * const { FastMCP } = wrapFastMCP(fastmcp);
 * const server = new FastMCP({ name: "my-server", version: "1.0.0" });
 * ```
 */
export function wrapFastMCP<T>(module: T): T {
  const sessionClass =
    module && typeof module === "object"
      ? Reflect.get(module, "FastMCPSession")
      : undefined;
  if (
    typeof sessionClass !== "function" ||
    typeof sessionClass.prototype?.connect !== "function"
  ) {
    debugLogger.notice.warn("Unsupported FastMCP module. Not wrapping.");
    return module;
  }
  const fastmcp = module as unknown as FastMCPModule;
  const prototype = fastmcp.FastMCPSession.prototype;
  const original = prototype.connect;
  if (Reflect.get(original, wrapped)) return module;

  const connect: FastMCPSession["connect"] = function (
    this: FastMCPSession,
    ...args
  ) {
    return fastMCPChannels.sessionConnect.invoke(original, this, args, {});
  };
  Object.defineProperty(connect, wrapped, { value: true });
  prototype.connect = connect;
  return module;
}
