const { newGlobalInvocationHook } = require(
  process.env.BRAINTRUST_TEST_GLOBAL_HOOK_RUNTIME,
);

module.exports = {
  getInvocationHook: newGlobalInvocationHook,
};
