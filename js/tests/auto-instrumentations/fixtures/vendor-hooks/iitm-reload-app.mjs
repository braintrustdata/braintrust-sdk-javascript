import assert from "node:assert";

import { value } from "virtual-reload-source-per-load";

assert.equal(value, 2);
assert.equal(globalThis.__braintrustIitmReloadHookValue, 2);
