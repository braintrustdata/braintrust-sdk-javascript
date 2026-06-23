// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
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
    ignoreHeaders: [
      "amz-sdk-invocation-id",
      "amz-sdk-request",
      "x-amz-date",
      "x-amz-security-token",
      "x-amzn-bedrock-trace",
    ],
  },
];

/** @type {import("@braintrust/seinfeld").RedactionSpec} */
export const redact = [
  "paranoid",
  {
    redactResponse(response) {
      return {
        ...response,
        headers: redactAwsResponseHeaders(response.headers),
      };
    },
  },
];

function redactAwsResponseHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return headers;
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      key.toLowerCase() === "date" || key.toLowerCase() === "x-amzn-requestid"
        ? "[REDACTED]"
        : value,
    ]),
  );
}
