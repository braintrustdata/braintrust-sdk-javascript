// When running JSON.stringify, use this replacer to guarantee that objects are
// serialized in a deterministic key order.
//
// https://gist.github.com/davidfurlong/463a83a33b70a3b6618e97ec9679e490
export function deterministicReplacer(_key: string, value: any): any {
  return value instanceof Object && !(value instanceof Array)
    ? Object.keys(value)
        .sort()
        .reduce((sorted: { [key: string]: unknown }, key) => {
          sorted[key] = value[key];
          return sorted;
        }, {})
    : value;
}

export function constructJsonArray(items: string[]) {
  return `[${items.join(",")}]`;
}
