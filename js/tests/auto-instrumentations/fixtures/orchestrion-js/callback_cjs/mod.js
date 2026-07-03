/*
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 */

function fetch(url, callback) {
  process.nextTick(() => {
    callback(null, 42);
  });
}

module.exports = { fetch };
