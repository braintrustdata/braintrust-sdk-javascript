// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    ignoreBodyFields: [
      // DeepSeek Harness derives this from the session id, while the paranoid
      // cassette redactor replaces prompt-cache identifiers in recordings.
      "prompt_cache_key",
    ],
  },
];
