/**
 * Unless explicitly stated otherwise all files in this repository are licensed under the Apache-2.0 License.
 * This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2025 Datadog, Inc.
 **/
const { fetch_simple, fetch_complex } = require("./instrumented.js");
const { assert, getInvocationHook } = require("../common/preamble.js");

const handler = (target, receiver, args) => {
  const originalCb = args[1];
  const wrappedCb = function (a, b) {
    assert.strictEqual(this.this, "this");
    assert.strictEqual(a, "arg1");
    assert.strictEqual(b, "arg2");
    arguments[1] = "arg2_mutated";
    return originalCb.apply(this, arguments);
  };

  args[1] = wrappedCb;
  return Reflect.apply(target, receiver, args);
};

getInvocationHook("orchestrion:undici:fetch_simple").intercept(handler);
getInvocationHook("orchestrion:undici:fetch.complex").intercept(handler);

assert.strictEqual(fetch_simple.length, 2);
assert.strictEqual(fetch_complex.length, 2);

const cb = function (a, b) {
  assert.strictEqual(this.this, "this");
  assert.strictEqual(a, "arg1");
  assert.strictEqual(b, "arg2_mutated");
  return "result";
};

assert.strictEqual(
  fetch_simple.apply({ this: "this" }, ["https://example.com", cb]),
  "return",
);
assert.strictEqual(
  fetch_complex.apply({ this: "this" }, [
    { url: "https://example.com", tuple: [] },
    cb,
  ]),
  "return",
);
