// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    // Strip the Google API key from URL query params before matching.
    ignoreQueryParams: ["key"],
    // Genkit/Google request bodies can include volatile generated IDs in
    // tool-call turns. Call order is stable for this scenario and is enough
    // to distinguish the recorded provider interactions.
    ignoreBodyFields: ["**"],
  },
];
