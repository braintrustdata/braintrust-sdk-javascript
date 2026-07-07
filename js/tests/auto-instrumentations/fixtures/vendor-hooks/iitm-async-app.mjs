import assert from "node:assert";
import getLabel, { foo } from "hook-target";
import getUnhookedLabel, { foo as unhookedFoo } from "unhooked-target";
import cjsTarget from "cjs-hook-target";
import { nestedValue } from "cjs-reexport-target";
import { sawIitmParam } from "./query-param-target.mjs?iitm=true";

assert.equal(foo, 57);
assert.equal(getLabel(), "patched");
assert.equal(unhookedFoo, 10);
assert.equal(getUnhookedLabel(), "untouched");
assert.equal(cjsTarget.value, 8);
assert.equal(nestedValue, "nested");
assert.equal(sawIitmParam, true);
