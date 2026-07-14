// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    // Strands makes deterministic, sequential OpenAI calls. Match by call
    // index so SDK-added defaults and generated ids do not make replay
    // depend on the runner environment.
    ignoreBodyFields: ["**"],
  },
];
