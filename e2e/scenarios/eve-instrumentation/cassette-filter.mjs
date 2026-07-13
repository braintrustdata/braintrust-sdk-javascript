// @ts-check
export { filter } from "../ai-sdk-instrumentation/cassette-filter.mjs";

/** @type {import("@braintrust/seinfeld").RedactionSpec} */
export const redact = [
  "paranoid",
  {
    redactResponse(response) {
      return {
        ...response,
        headers: Object.fromEntries(
          Object.entries(response.headers).filter(
            ([key]) =>
              key.toLowerCase() !== "openai-organization" &&
              key.toLowerCase() !== "openai-project",
          ),
        ),
      };
    },
  },
];
