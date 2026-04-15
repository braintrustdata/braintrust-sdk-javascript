import { Request, Response, NextFunction } from "express";
import { IncomingHttpHeaders } from "http";
import createError from "http-errors";
import { LRUCache } from "../src/prompt-cache/lru-cache";
import { BraintrustState, LoginOptions, loginToState } from "../src/logger";

export interface RequestContext {
  appOrigin: string;
  token: string | undefined;
  state: BraintrustState | undefined;
  projectId: string | undefined;
}
declare module "express" {
  interface Request {
    ctx?: RequestContext;
  }
}

export function authorizeRequest(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const ctx: RequestContext = {
      appOrigin: extractAllowedOrigin(req.headers[ORIGIN_HEADER]),
      token: undefined,
      state: undefined,
      projectId: parseHeader(req.headers, PROJECT_ID_HEADER),
    };

    // Extract token and data from request
    if (
      req.headers.authorization ||
      req.headers[BRAINTRUST_AUTH_TOKEN_HEADER]
    ) {
      const tokenText = parseBraintrustAuthHeader(req.headers);
      if (!tokenText) {
        return next(createError(400, "Invalid authorization token format"));
      }
      ctx.token = tokenText.toLowerCase() === "null" ? undefined : tokenText;
    }

    req.ctx = ctx;

    next(); // Proceed to next middleware/controller
  } catch (e) {
    next(e);
  }
}

const loginCache = new LRUCache<string, BraintrustState>({
  max: 32, // TODO: Make this configurable
});

async function cachedLogin(options: LoginOptions): Promise<BraintrustState> {
  const key = JSON.stringify(options);
  const cached = loginCache.get(key);
  if (cached) {
    return cached;
  }

  const state = await loginToState(options);
  loginCache.set(key, state);
  return state;
}

export function makeCheckAuthorized(allowedOrgName: string | undefined) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx?.token) {
      return next(createError(401, "Unauthorized"));
    }

    try {
      const orgName = parseHeader(req.headers, "x-bt-org-name");

      if (!orgName) {
        return next(createError(400, "Missing x-bt-org-name header"));
      }

      if (allowedOrgName && allowedOrgName !== orgName) {
        const errorMessage = `Org '${orgName}' is not allowed. Only org '${allowedOrgName}' is allowed.`;
        return next(createError(403, errorMessage));
      }

      const state = await cachedLogin({
        apiKey: req.ctx?.token,
        orgName: orgName,
      });
      req.ctx.state = state;
      next();
    } catch (e) {
      console.error("Authorization error:", e);
      return next(createError(401, "Unauthorized"));
    }
  };
}

function parseBraintrustAuthHeader(
  headers: IncomingHttpHeaders | Record<string, string>,
): string | undefined {
  const tokenString = parseHeader(headers, BRAINTRUST_AUTH_TOKEN_HEADER);
  return tokenString ?? parseAuthHeader(headers) ?? undefined;
}

function parseHeader(
  headers: IncomingHttpHeaders | Record<string, string>,
  headerName: string,
): string | undefined {
  const token = headers[headerName];
  let tokenString;
  if (typeof token === "string") {
    tokenString = token;
  } else if (Array.isArray(token) && token.length > 0) {
    tokenString = token[0];
  }

  return tokenString;
}

export type StaticOrigin =
  | boolean
  | string
  | RegExp
  | Array<boolean | string | RegExp>;

export function checkOrigin(
  requestOrigin: string | undefined,
  callback: (err: Error | null, origin?: StaticOrigin) => void,
) {
  if (!requestOrigin) {
    return callback(null, true);
  }

  // the origins can be glob patterns
  for (const origin of WHITELISTED_ORIGINS || []) {
    if (
      (origin instanceof RegExp && origin.test(requestOrigin)) ||
      origin === requestOrigin
    ) {
      return callback(null, requestOrigin);
    }
  }

  return callback(null, false);
}

const BRAINTRUST_AUTH_TOKEN_HEADER = "x-bt-auth-token";
const ORIGIN_HEADER = "origin";
const PROJECT_ID_HEADER = "x-bt-project-id";

function extractAllowedOrigin(originHeader: string | undefined): string {
  let allowedOrigin: string = MAIN_ORIGIN;
  checkOrigin(originHeader, (err, origin) => {
    if (!err && originHeader && origin) {
      allowedOrigin = originHeader;
    }
  });
  return allowedOrigin;
}

const MAIN_ORIGIN = "https://www.braintrust.dev";
const WHITELISTED_ORIGINS = [
  MAIN_ORIGIN,
  "https://www.braintrustdata.com",
  new RegExp("https://.*.preview.braintrust.dev"),
]
  .concat(
    process.env.WHITELISTED_ORIGIN ? [process.env.WHITELISTED_ORIGIN] : [],
  )
  .concat(
    process.env.BRAINTRUST_APP_URL ? [process.env.BRAINTRUST_APP_URL] : [],
  );

function parseAuthHeader(
  headers: Record<string, string | string[] | undefined>,
) {
  const authHeader = headers["authorization"];
  let authValue = null;
  if (Array.isArray(authHeader)) {
    authValue = authHeader[authHeader.length - 1];
  } else {
    authValue = authHeader;
  }

  if (!authValue) {
    return null;
  }

  const parts = authValue.split(" ");
  if (parts.length !== 2) {
    return null;
  }
  return parts[1];
}

export const baseAllowedHeaders = [
  "Content-Type",
  "X-Amz-Date",
  "Authorization",
  "X-Api-Key",
  "X-Amz-Security-Token",
  "x-bt-auth-token",
  "x-bt-parent",
  // These are eval-specific
  "x-bt-org-name",
  "x-bt-project-id",
  "x-bt-stream-fmt",
  "x-bt-use-cache",
  "x-stainless-os",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-arch",
  "x-bt-use-gateway"
];
