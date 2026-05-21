// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    // Flue includes temp workspace paths, generated operation ids, and
    // prompt_cache_key values in OpenAI Responses request bodies. The scenario
    // call order is the stable contract, so use callIndex for disambiguation.
    ignoreBodyFields: ["**"],
  },
];
