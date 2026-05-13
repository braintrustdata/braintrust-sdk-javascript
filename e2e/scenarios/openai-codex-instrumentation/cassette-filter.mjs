export const filter = [
  "default",
  {
    normalizeRequest(request) {
      const url = new URL(request.url);
      if (
        url.hostname === "api.openai.com" &&
        url.pathname === "/v1/responses" &&
        (request.method === "GET" || request.method === "POST")
      ) {
        return {
          ...request,
          body: { kind: "empty" },
        };
      }

      return request;
    },
  },
];
