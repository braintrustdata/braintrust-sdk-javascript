const { newGlobalTracingChannel } = require(
  process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME,
);

module.exports = {
  getTracingHook: newGlobalTracingChannel,
};
