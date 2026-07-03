"use strict";

/**
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 **/
// Mimics the mariadb v2 pattern: query methods are arrow functions
// assigned to `this` inside a function constructor.
function Connection(opts) {
  this._query = async () => {
    return 42;
  };
}

module.exports = { Connection };
