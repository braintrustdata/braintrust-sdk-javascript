import { createHash } from "node:crypto";

// @cursor/sdk 1.0.38 serves agent turns on RunSSE and sends client messages
// separately. The stream has to be proxied live or the turn never finishes.
export const streamingRequests = [
  /\/agent\.v1\.AgentService\/Run(?:SSE|Poll)?(?:\?|$)/,
];

export const filter = [
  "default",
  {
    normalizeRequest(req) {
      // RunSSE carries the turn. BidiAppend is the client's ack stream: the
      // protobuf includes fresh session ids, and every recorded response is
      // an empty 200. Match those in call order instead of by bytes.
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

      // Statsig can include third-party access tokens in dynamic configs.
      // They are not needed by these scenarios and must not reach cassettes.
      for (const entry of Object.values(config.dynamic_configs)) {
        if (entry?.value && typeof entry.value === "object") {
          delete entry.value.mapbox_access_token;
        }
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
        customIDs: Object.fromEntries(
          Object.keys(config.evaluated_keys?.customIDs ?? {}).map((key) => [
            key,
            "[REDACTED]",
          ]),
        ),
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
