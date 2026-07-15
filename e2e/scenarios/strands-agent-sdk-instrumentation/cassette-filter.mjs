// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    normalizeRequest(req) {
      if (
        req.body.kind !== "json" ||
        !req.body.value ||
        typeof req.body.value !== "object" ||
        Array.isArray(req.body.value)
      ) {
        return req;
      }

      const value = /** @type {Record<string, unknown>} */ (req.body.value);
      const messages = value.messages;
      if (!Array.isArray(messages)) {
        return req;
      }

      const systemMessage = messages.find((message) => {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          return false;
        }
        const value = /** @type {Record<string, unknown>} */ (message);
        return value.role === "system" && typeof value.content === "string";
      });
      if (!systemMessage) {
        return req;
      }

      // The system prompt identifies each deterministic scenario call. The
      // tool invocation deliberately has two entries and still uses call
      // order to distinguish the initial request from its follow-up.
      return {
        ...req,
        body: {
          kind: "json",
          value: {
            systemPrompt: /** @type {Record<string, string>} */ (systemMessage)
              .content,
          },
        },
      };
    },
  },
];
