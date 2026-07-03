/**
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 **/
import { Undici } from "./instrumented.mjs";
import { assert, getContext } from "../common/preamble.js";
const context = getContext("orchestrion:undici:Undici:fetch");
const undici = new Undici();
const result = await undici.fetch("https://example.com");
assert.strictEqual(result, 42);
assert.deepStrictEqual(context, {
  start: true,
  end: true,
  asyncStart: 42,
  asyncEnd: 42,
});
