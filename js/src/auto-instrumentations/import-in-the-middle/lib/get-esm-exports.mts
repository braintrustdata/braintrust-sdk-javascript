"use strict";

import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { initSync, parse as parseWasm } from "es-module-lexer";

const require = createRequire(import.meta.url);

type LexerImport = {
  n: string;
  se: number;
  ss: number;
};
type LexerExport = {
  n: string;
};
type LexerParseResult = readonly [
  readonly LexerImport[],
  readonly LexerExport[],
  unknown,
  boolean,
];

const flag = "--disallow-code-generation-from-strings";
const disallowCodegen =
  process.execArgv.includes(flag) ||
  (process.env.NODE_OPTIONS?.includes(flag) ?? false);

// initSync compiles the Wasm module up front so parse can run inside
// synchronous loader hooks as well as the off-thread loader.
initSync();

let parse: typeof parseWasm = parseWasm;

if (disallowCodegen) {
  parse = loadAsmParse();
}

function loadAsmParse(): typeof parseWasm {
  const asmPath = require.resolve("es-module-lexer/js");
  const source =
    readFileSync(asmPath, "utf8").replace(
      "export function parse",
      "function parse",
    ) + "\nmodule.exports = { parse }\n";
  const mod = new Module(asmPath) as NodeJS.Module & {
    _compile(source: string, filename: string): void;
    exports: { parse: typeof parseWasm };
  };
  mod.filename = asmPath;
  mod._compile(source, asmPath);
  return mod.exports.parse;
}

function decodeExportName(name: string): string {
  const first = name.charCodeAt(0);
  if (
    first === 0x22 /* " */ ||
    first === 0x27 /* ' */ ||
    !name.includes("\\")
  ) {
    return name;
  }
  try {
    return JSON.parse(`"${name}"`) as string;
  } catch {
    return name;
  }
}

// es-module-lexer reports a bare `export * from <mod>` only as an import with no
// matching export entry, so match the statement text to rebuild the transitive marker.
const GAP = String.raw`(?:\s|/\*[^]*?\*/|//[^\n]*\n)*`;
const STAR_REEXPORT = new RegExp(`^export${GAP}\\*${GAP}from`);

export function lexEsm(moduleSource: string): {
  exportNames: Set<string>;
  hasModuleSyntax: boolean;
} {
  const exportNames = new Set<string>();
  const [imports, exports, , hasModuleSyntax] = parse(
    moduleSource,
  ) as LexerParseResult;

  for (const exported of exports) {
    exportNames.add(decodeExportName(exported.n));
  }

  for (const imported of imports) {
    if (STAR_REEXPORT.test(moduleSource.slice(imported.ss, imported.se))) {
      exportNames.add(`* from ${imported.n}`);
    }
  }

  return { exportNames, hasModuleSyntax };
}
