export const filter = [
  "default",
  {
    normalizeRequest(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.hostname === "router.huggingface.co") {
        return { ...req, body: { kind: "empty" } };
      }
      return req;
    },
  },
];
