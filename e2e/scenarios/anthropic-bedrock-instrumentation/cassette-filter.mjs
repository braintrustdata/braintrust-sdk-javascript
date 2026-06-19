export const filter = [
  "default",
  {
    normalizeRequest(req) {
      try {
        const url = new URL(req.url);
        if (/^bedrock-runtime\.[^.]+\.amazonaws\.com$/.test(url.hostname)) {
          url.hostname = "bedrock-runtime.aws-region.amazonaws.com";
          return {
            ...req,
            url: url.toString(),
          };
        }
      } catch {
        // Keep the default-normalized request unchanged.
      }

      return req;
    },
  },
];
