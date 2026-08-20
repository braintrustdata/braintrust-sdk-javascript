// @ts-check
import { filter as aiSdkFilter } from "../ai-sdk-instrumentation/cassette-filter.mjs";

/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  ...aiSdkFilter,
  {
    // Eve's model-message and built-in-tool serialization evolves between
    // supported releases. The fixture asserts the resulting events and spans,
    // while call order selects the deterministic recorded model responses.
    ignoreBodyFields: ["messages", "tools"],
  },
];

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
