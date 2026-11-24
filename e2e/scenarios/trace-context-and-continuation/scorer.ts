import { defineScorer, traced } from "braintrust";

export default defineScorer(({ output, expected }) =>
  traced(
    () => traced(() => Number(output === expected), { name: "score-child" }),
    {
      name: "score",
    },
  ),
);
