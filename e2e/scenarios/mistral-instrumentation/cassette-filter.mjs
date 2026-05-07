// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    /**
     * Mistral's client generates a unique `name` field per session
     * (e.g. "braintrust-e2e-<uuid>"). Normalize it so cassette matching
     * isn't broken by the per-run suffix.
     *
     * @param {import("@braintrust/seinfeld").RecordedRequest} req
     * @returns {import("@braintrust/seinfeld").RecordedRequest}
     */
    normalizeRequest(req) {
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
  },
];
