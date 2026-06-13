// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    ignoreBodyFields: [
      // Ignore all body fields — deterministic call order makes callIndex
      // the sole discriminator, which is stable across SDK releases.
      "**",
    ],
  },
];
