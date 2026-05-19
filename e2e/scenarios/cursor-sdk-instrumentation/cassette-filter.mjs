import { createHash } from "node:crypto";

export const streamingRequests = [/\/agent\.v1\.AgentService\/Run(?:\?|$)/];

export const filter = [
  "default",
  {
    normalizeRequest(req) {
      if (req.url.includes("/agent.v1.AgentService/Run")) {
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
      outer.config = JSON.stringify(config);

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
