/**
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 **/
const { Server } = require("./instrumented.js");
const { assert, getContext } = require("../common/preamble.js");
const context = getContext("orchestrion:undici:register");
(async () => {
  const server = new Server();
  const result = server.register();
  assert.strictEqual(result, 1);
  assert.deepStrictEqual(context, {
    start: true,
    end: 1,
  });
})();
