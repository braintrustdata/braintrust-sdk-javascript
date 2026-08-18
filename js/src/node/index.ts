/**
 * An isomorphic JS library for working with [Braintrust](https://braintrust.dev/). This library contains functionality
 * for running evaluations, logging completions, loading and invoking functions, and more.
 *
 * `braintrust` is distributed as a [library on NPM](https://www.npmjs.com/package/braintrust).
 * It is also open source and available on [GitHub](https://github.com/braintrustdata/braintrust-sdk-javascript/tree/main/js).
 *
 * ### Quickstart
 *
 * Install the library with npm (or yarn).
 *
 * ```bash
 * npm install braintrust
 * ```
 *
 * Then, create a file like `hello.eval.ts` with the following content:
 *
 * ```javascript
 * import { Eval } from "braintrust";
 *
 * function isEqual({ output, expected }: { output: string; expected?: string }) {
 *   return { name: "is_equal", score: output === expected ? 1 : 0 };
 * }
 *
 * Eval("Say Hi Bot", {
 *   data: () => {
 *     return [
 *       {
 *         input: "Foo",
 *         expected: "Hi Foo",
 *       },
 *       {
 *         input: "Bar",
 *         expected: "Hello Bar",
 *       },
 *     ]; // Replace with your eval dataset
 *   },
 *   task: (input: string) => {
 *     return "Hi " + input; // Replace with your LLM call
 *   },
 *   scores: [isEqual],
 * });
 * ```
 *
 * Finally, run the script with `npx bt eval hello.eval.ts`.
 *
 * ```bash
 * BRAINTRUST_API_KEY=<YOUR_BRAINTRUST_API_KEY> npx bt eval hello.eval.ts
 * ```
 *
 * @module braintrust
 */

import { configureNode } from "./config";

configureNode();

export * from "../exports";
export * as default from "../exports";
