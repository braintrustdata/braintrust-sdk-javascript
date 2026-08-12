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

function normalizeResponseValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeResponseValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const normalized = Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      entry === null ? [] : [[key, normalizeResponseValue(entry)]],
    ),
  );
  if (
    Array.isArray(normalized.choices) &&
    typeof normalized.created === "number" &&
    typeof normalized.id === "string" &&
    typeof normalized.model === "string" &&
    normalized.usage &&
    typeof normalized.usage === "object" &&
    typeof normalized.system_fingerprint !== "string"
  ) {
    normalized.system_fingerprint = "";
  }
  return normalized;
}

export const redact = [
  "paranoid",
  {
    redactResponse(response) {
      if (response.body.kind !== "json") {
        return response;
      }
      return {
        ...response,
        body: {
          kind: "json",
          value: normalizeResponseValue(response.body.value),
        },
      };
    },
  },
];
