// Unless explicitly stated otherwise all files in this repository are licensed under the Apache 2.0 License.
//
// This product includes software developed at Datadog (https://www.datadoghq.com/). Copyright 2021 Datadog, Inc.

// This module intentionally has no imports. Consumers can branch on sync hook
// support without loading the parser dependencies used by create-hook.mts.

const version = process.versions.node;
const NODE_MAJOR = parseInt(version, 10);
let NODE_MINOR: number | undefined;
let NODE_PATCH: number | undefined;

function readMinorAndPatch(): void {
  const firstDot = version.indexOf(".");
  const secondDot = version.indexOf(".", firstDot + 1);
  NODE_MINOR = parseInt(version.slice(firstDot + 1, secondDot), 10);
  NODE_PATCH = parseInt(version.slice(secondDot + 1), 10);
}

/**
 * Whether the running Node.js can correctly run the synchronous loader via
 * `module.registerHooks`.
 *
 * `module.registerHooks` exists since v22.15, but its synchronous load hook
 * rejected the nullish CommonJS `source` the loader returns for `require()`s
 * pulled into the ESM graph until nodejs/node#59929.
 */
export function supportsSyncHooks(): boolean {
  if (NODE_MAJOR >= 26) return true;
  if (NODE_MAJOR < 22 || NODE_MAJOR === 23) return false;

  readMinorAndPatch();
  if (NODE_MAJOR === 25) return NODE_MINOR! >= 1;
  if (NODE_MAJOR === 24)
    return NODE_MINOR! > 11 || (NODE_MINOR === 11 && NODE_PATCH! >= 1);
  return NODE_MINOR! > 22 || (NODE_MINOR === 22 && NODE_PATCH! >= 3);
}
