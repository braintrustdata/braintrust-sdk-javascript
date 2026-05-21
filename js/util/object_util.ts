import { isArray, isObject, isObjectOrArray } from "./type_util";

// Fields that automatically use set-union merge semantics (unless in mergePaths).
const SET_UNION_FIELDS = new Set(["tags"]);

// Block certain keys from being merged to prevent prototype pollution and other unsafe merges.
const FORBIDDEN_MERGE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// Mutably updates `mergeInto` with the contents of `mergeFrom`, merging objects
// deeply. Does not merge any further than `merge_paths`.
// For fields in SET_UNION_FIELDS (like "tags"), arrays are merged as sets (union)
// unless the field is explicitly listed in mergePaths (opt-out to replacement).
export function mergeDictsWithPaths({
  mergeInto,
  mergeFrom,
  mergePaths,
}: {
  mergeInto: Record<string, unknown>;
  mergeFrom: Record<string, unknown>;
  mergePaths: string[][];
}) {
  const mergePathsSerialized = new Set<string>(
    mergePaths.map((p) => JSON.stringify(p)),
  );
  return mergeDictsWithPathsHelper({
    mergeInto,
    mergeFrom,
    path: [],
    mergePaths: mergePathsSerialized,
  });
}

function mergeDictsWithPathsHelper({
  mergeInto,
  mergeFrom,
  path,
  mergePaths,
}: {
  mergeInto: Record<string, unknown>;
  mergeFrom: Record<string, unknown>;
  path: string[];
  mergePaths: Set<string>;
}) {
  Object.entries(mergeFrom).forEach(([k, mergeFromV]) => {
    if (FORBIDDEN_MERGE_KEYS.has(k)) return;
    const fullPath = path.concat([k]);
    const fullPathSerialized = JSON.stringify(fullPath);
    const mergeIntoV = recordFind(mergeInto, k);

    // Check if this field should use set-union merge (e.g., "tags" at top level)
    const isSetUnionField =
      path.length === 0 &&
      SET_UNION_FIELDS.has(k) &&
      !mergePaths.has(fullPathSerialized);

    if (isSetUnionField && isArray(mergeIntoV) && isArray(mergeFromV)) {
      // Set-union merge: combine arrays, deduplicate using JSON.stringify for objects
      const seen = new Set<string>();
      const combined: unknown[] = [];
      for (const item of [...mergeIntoV, ...mergeFromV]) {
        const key =
          typeof item === "object" ? JSON.stringify(item) : String(item);
        if (!seen.has(key)) {
          seen.add(key);
          combined.push(item);
        }
      }
      mergeInto[k] = combined;
    } else if (
      isObject(mergeIntoV) &&
      isObject(mergeFromV) &&
      !mergePaths.has(fullPathSerialized)
    ) {
      mergeDictsWithPathsHelper({
        mergeInto: mergeIntoV,
        mergeFrom: mergeFromV,
        path: fullPath,
        mergePaths,
      });
    } else {
      if (mergeFromV !== undefined) {
        mergeInto[k] = mergeFromV;
      }
    }
  });

  return mergeInto;
}

// Mutably updates `mergeInto` with the contents of `mergeFrom`, merging objects deeply.
export function mergeDicts(
  mergeInto: Record<string, unknown>,
  mergeFrom: Record<string, unknown>,
) {
  return mergeDictsWithPaths({ mergeInto, mergeFrom, mergePaths: [] });
}

// Recursively walks down `lhs` and `rhs`, invoking `fn` for each key in any
// `rhs` subobject which is not in the corresponding `lhs` subobject.
export function forEachMissingKey({
  lhs,
  rhs,
  fn,
}: {
  lhs: unknown;
  rhs: unknown;
  fn: (args: {
    lhs: Record<string, unknown>;
    k: string;
    v: unknown;
    path: string[];
  }) => void;
}) {
  function helper(lhs: unknown, rhs: unknown, path: string[]) {
    if (lhs instanceof Object) {
      if (!(rhs instanceof Object)) {
        return;
      }
      const lhsRec = lhs as Record<string, unknown>;
      const rhsRec = rhs as Record<string, unknown>;
      for (const [k, v] of Object.entries(rhsRec)) {
        if (!(k in lhsRec)) {
          fn({ lhs: lhsRec, k, v, path });
        } else {
          helper(lhsRec[k], rhsRec[k], [...path, k]);
        }
      }
    }
  }
  helper(lhs, rhs, []);
}

export function mapAt<K, V>(m: Map<K, V>, k: K): V {
  const ret = m.get(k);
  if (ret === undefined) {
    throw new Error(`Map does not contain key ${k}`);
  }
  return ret;
}

export function mapSetDefault<K, V>(m: Map<K, V>, k: K, _default: V): V {
  const ret = m.get(k);
  if (ret === undefined) {
    m.set(k, _default);
    return _default;
  } else {
    return ret;
  }
}

export function mapSetNotPresent<K, V>(m: Map<K, V>, k: K, v: V): Map<K, V> {
  if (m.has(k)) {
    throw new Error(`Map already contains key ${k}`);
  }
  return m.set(k, v);
}

export function recordFind<K extends string | number | symbol, V>(
  m: { [k in K]?: V },
  k: K,
): V | undefined {
  return m[k];
}

export function recordAt<K extends string | number | symbol, V>(
  m: { [k in K]?: V },
  k: K,
): V {
  const ret = recordFind(m, k);
  if (ret === undefined) {
    throw new Error(`Record does not contain key ${String(k)}`);
  }
  return ret;
}

export function recordSetDefault<K extends string | number | symbol, V>(
  m: { [k in K]?: V },
  k: K,
  _default: V,
): V {
  const ret = recordFind(m, k);
  if (ret === undefined) {
    m[k] = _default;
    return _default;
  } else {
    return ret;
  }
}

/**
 * @returns a typed array of the Record's keys
 */
export function getRecordKeys<T extends Record<string | number | symbol, any>>(
  obj: T,
): Array<keyof T> {
  return Object.keys(obj);
}

/**
 * Get object value by providing a path to it as an array.
 * @example getObjValueByPath({ bar: { foo: "Hello, world!" } }, ["bar", "foo"]); // "Hello, world!"
 */
export function getObjValueByPath(
  row: Record<string, unknown>,
  path: string[],
): unknown {
  let curr: unknown = row;
  for (const p of path) {
    if (!isObjectOrArray(curr)) {
      return null;
    }
    curr = curr[p];
  }
  return curr;
}
