// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    normalizeRequest(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.hostname === "api.anthropic.com") {
        return { ...req, body: { kind: "empty" } };
      }
      return req;
    },
  },
];
