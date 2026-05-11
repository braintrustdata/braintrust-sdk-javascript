// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    // Strip the Google API key from URL query params before matching.
    ignoreQueryParams: ["key"],
    // Ignore all body fields — conversation history contains volatile tool
    // call IDs (functionCall.id) that change every run. callIndex is the
    // sole discriminator, which is stable as long as call order is stable.
    ignoreBodyFields: ["**"],
  },
];
