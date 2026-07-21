// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    ignoreBodyFields: [
      // Codex includes fresh installation, prompt-cache, thread, and turn IDs in
      // every request. This scenario has deterministic call order, so callIndex
      // remains a stable discriminator without retaining those volatile bodies.
      "**",
    ],
  },
];
