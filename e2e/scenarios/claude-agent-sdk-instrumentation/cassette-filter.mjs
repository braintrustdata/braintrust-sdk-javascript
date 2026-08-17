// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    normalizeRequest(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.hostname !== "api.anthropic.com") {
        return req;
      }

      // Claude can send a title request at the same time as a model request.
      // Give each request class a separate cassette sequence. Large request
      // bodies contain volatile Claude system data, so match them by order.
      const requestClass =
        req.body?.kind === "json" && req.body.value?.output_config
          ? "title"
          : "model";
      url.pathname = `${url.pathname}/__cassette_${requestClass}`;

      return {
        ...req,
        body: { kind: "empty" },
        url: url.toString(),
      };
    },
  },
];
