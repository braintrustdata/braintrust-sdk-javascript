import { pathToFileURL } from "node:url";

/** The URL of the built SDK file running this code, in both CJS and ESM builds. */
export function getCurrentModuleUrl(): string {
  if (typeof __filename !== "undefined") {
    return pathToFileURL(__filename).href;
  }

  const stack = new Error().stack ?? "";
  const match =
    stack.match(/\((file:\/\/[^)]+)\)/) ?? stack.match(/\s(file:\/\/\S+)/);
  if (match) {
    return match[1].replace(/:\d+:\d+$/, "");
  }

  return pathToFileURL(process.argv[1] ?? process.cwd()).href;
}
