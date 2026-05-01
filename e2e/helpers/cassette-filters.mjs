/**
 * Per-scenario seinfeld filter specs. Each entry maps a scenario/normalizer
 * name to a seinfeld FilterSpec, which is passed to createCassette({ filters }).
 *
 * Wildcard paths: `*` matches one segment, `**` matches any number.
 */

const AI_SDK_VOLATILE_FIELDS = {
  ignoreBodyFields: [
    "experimental_generateMessageId",
    "messageId",
    "messages.*.id",
    "messages.*.experimental_messageId",
    "input.*.id",
    "input.*.experimental_messageId",
  ],
};

const MISTRAL_VOLATILE_FIELDS = {
  normalizeRequest: (req) => {
    if (
      req.body.kind !== "json" ||
      req.body.value === null ||
      typeof req.body.value !== "object" ||
      Array.isArray(req.body.value)
    ) {
      return req;
    }
    const value = /** @type {Record<string, unknown>} */ (req.body.value);
    if (
      typeof value["name"] === "string" &&
      /** @type {string} */ (value["name"]).startsWith("braintrust-e2e-")
    ) {
      return {
        ...req,
        body: {
          kind: "json",
          value: { ...value, name: "braintrust-e2e-<placeholder>" },
        },
      };
    }
    return req;
  },
};

export const CASSETTE_FILTERS = {
  default: "default",
  "ai-sdk": ["default", AI_SDK_VOLATILE_FIELDS],
  "ai-sdk-instrumentation": ["default", AI_SDK_VOLATILE_FIELDS],
  "ai-sdk-otel-export": ["default", AI_SDK_VOLATILE_FIELDS],
  "mistral-instrumentation": ["default", MISTRAL_VOLATILE_FIELDS],
};
