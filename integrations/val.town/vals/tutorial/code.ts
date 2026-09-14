import { LevenshteinScorer } from "npm:autoevals";
import { Eval } from "npm:braintrust@^3.30.0";

Eval("Say Hi Bot", {
  data: () => {
    return [
      {
        input: "Foo",
        expected: "Hi Foo",
      },
      {
        input: "Bar",
        expected: "Hello Bar",
      },
    ]; // Replace with your eval dataset
  },
  task: (input) => {
    return "Hi " + input; // Replace with your LLM call
  },
  scores: [LevenshteinScorer],
});
