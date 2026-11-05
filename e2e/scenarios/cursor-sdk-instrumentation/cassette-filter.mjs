import { createHash } from "node:crypto";

export const streamingRequests = [
  {
    url: /\/agent\.v1\.AgentService\/Run(?:\?|$)/,
    httpVersion: "2",
    requestFraming: "connect",
  },
  /\/agent\.v1\.AgentService\/RunSSE(?:\?|$)/,
  /\/aiserver\.v1\.BidiService\/BidiAppend(?:\?|$)/,
];

export const filter = [
  "default",
  {
    normalizeRequest(req) {
      // Both transports contain generated run IDs and local tool messages.
      // Match by endpoint and call order, as for the bidirectional Run stream.
      if (
        req.url.includes("/agent.v1.AgentService/Run") ||
        req.url.includes("/aiserver.v1.BidiService/BidiAppend")
      ) {
        return {
          ...req,
          body: { kind: "empty" },
        };
      }
      return req;
    },
  },
];

export const redact = [
  "paranoid",
  {
    redactResponse(res) {
      if (
        res.body?.kind !== "binary-draft" ||
        !res.body.contentType?.toLowerCase().includes("application/json")
      ) {
        return res;
      }

      let outer;
      try {
        outer = JSON.parse(new TextDecoder().decode(res.body.bytes));
      } catch {
        return res;
      }

      if (typeof outer.config !== "string") {
        return res;
      }

      let config;
      try {
        config = JSON.parse(outer.config);
      } catch {
        return res;
      }

      if (!config.dynamic_configs || !config.feature_gates || !config.user) {
        return res;
      }

      config.user = {
        appVersion: config.user.appVersion,
        country: "[REDACTED]",
        custom: {
          backendServiceName: config.user.custom?.backendServiceName,
          clientChannel: config.user.custom?.clientChannel,
          clientType: config.user.custom?.clientType,
          clientVersion: config.user.custom?.clientVersion,
          isInPrivacyMode: config.user.custom?.isInPrivacyMode,
          privacyModeType: config.user.custom?.privacyModeType,
        },
        customIDs: { teamID: "[REDACTED]" },
        ip: "[REDACTED]",
        statsigEnvironment: config.user.statsigEnvironment,
        userAgent: config.user.userAgent,
        userID: "[REDACTED]",
      };
      config.evaluated_keys = {
        ...config.evaluated_keys,
        teamID: "[REDACTED]",
        userID: "[REDACTED]",
      };
      // Statsig includes a Mapbox credential unrelated to agent execution.
      // This nested JSON lives in a binary body, outside preset redaction.
      outer.config = JSON.stringify(config, (key, value) =>
        key === "mapbox_access_token" ? "[REDACTED]" : value,
      );

      const bytes = new TextEncoder().encode(JSON.stringify(outer));
      return {
        ...res,
        body: {
          kind: "binary-draft",
          bytes,
          contentType: res.body.contentType,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      };
    },
  },
];
