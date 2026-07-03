"use strict";

/**
 * Forked from @apm-js-collab/code-transformer@0.12.0 (Orchestrion-JS),
 * licensed under Apache-2.0. Modified by Braintrust.
 **/
// Named object pattern: async arrow function assigned to a property
// on a named identifier (not `this`).
const conn = {};
conn.query = async () => {
  return 42;
};

module.exports = { conn };
