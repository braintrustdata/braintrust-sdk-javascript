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
      if (req.method === "POST" && url.hostname === "api.openai.com") {
        return { ...req, body: normalizeBody(req.body) };
      }
      return req;
    },
  },
];

// Keep request content and tool schemas in the match. Only the working
// directory, current date, and per-session cache key vary by run.
/** @param {unknown} value @param {string} [key] @returns {any} */
function normalizeBody(value, key) {
  if (typeof value === "string") {
    if (key === "prompt_cache_key") {
      return "<session-id>";
    }
    return value
      .replace(/Current date: [^\n]+/g, "Current date: <date>")
      .replace(
        /Current working directory: [^\n]+/g,
        "Current working directory: <cwd>",
      )
      .replace(/<cwd>\n[^\n]+\n<\/cwd>/g, "<cwd>\n<directory>\n</cwd>");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeBody(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeBody(entry, key),
      ]),
    );
  }
  return value;
}
