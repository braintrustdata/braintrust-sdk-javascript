"use strict";

/**
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 **/
const { Connection } = require("./instrumented.js");
const { assert, getContext } = require("../common/preamble.js");
const context = getContext("orchestrion:undici:Connection_query");

(async () => {
  const conn = new Connection({ host: "localhost" });
  const result = await conn._query();
  assert.strictEqual(result, 42);
  assert.deepStrictEqual(context, {
    start: true,
    end: true,
    asyncStart: 42,
    asyncEnd: 42,
  });
})();
