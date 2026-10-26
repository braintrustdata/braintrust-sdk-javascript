// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    normalizeRequest(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.hostname === "api.anthropic.com") {
        // Pi 1.x uses the beta endpoint flag for the same messages exchange.
        url.searchParams.delete("beta");
        return { ...req, url: url.toString(), body: { kind: "empty" } };
      }
      return req;
    },
  },
];
