/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

const { fetch } = require("./instrumented.js");
const { assert, getContext } = require("../common/preamble.js");
const context = getContext("orchestrion:undici:fetch_ast_query");
(async () => {
  const result = await fetch("https://example.com");
  assert.strictEqual(result, 42);
  assert.deepStrictEqual(context, {
    start: true,
    end: true,
    asyncStart: 42,
    asyncEnd: 42,
  });
})();
