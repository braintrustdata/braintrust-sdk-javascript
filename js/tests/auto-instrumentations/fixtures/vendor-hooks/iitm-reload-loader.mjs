const RELOAD_URL = new URL("file:///virtual/reload-source-per-load.mjs").href;

let loadCount = 0;

export async function resolve(specifier, context, parentResolve) {
  if (specifier === "virtual-reload-source-per-load") {
    return { url: RELOAD_URL, format: "module", shortCircuit: true };
  }
  if (specifier === RELOAD_URL) {
    return { url: specifier, format: "module", shortCircuit: true };
  }
  return parentResolve(specifier, context);
}

export async function load(url, context, parentLoad) {
  if (url === RELOAD_URL) {
    loadCount++;
    return {
      format: "module",
      source: `export const value = ${loadCount}\n`,
      shortCircuit: true,
    };
  }
  return parentLoad(url, context);
}
