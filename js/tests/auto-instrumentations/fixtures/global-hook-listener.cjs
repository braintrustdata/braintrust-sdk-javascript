const {
  newGlobalTracingChannel,
} = require("../../../dist/auto-instrumentations/global-instrumentation-hooks.cjs");

module.exports = {
  getTracingHook: newGlobalTracingChannel,
};
