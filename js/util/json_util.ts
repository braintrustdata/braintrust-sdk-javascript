// When running JSON.stringify, use this replacer to guarantee that objects are
// serialized in a deterministic key order.
//
// https://gist.github.com/davidfurlong/463a83a33b70a3b6618e97ec9679e490
export function deterministicReplacer(_key: string, value: any): any {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => {
        if (left < right) {
          return -1;
        }
        if (left > right) {
          return 1;
        }
        return 0;
      }),
    );
  }
  return value;
}

export function constructJsonArray(items: string[]) {
  return `[${items.join(",")}]`;
}
