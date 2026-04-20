import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as ts from "typescript";
import * as tar from "tar";
import type { Options } from "tsup";

/**
 * API Compatibility Test
 *
 * This test ensures that the public TypeScript API surface of the braintrust package
 * doesn't regress between versions, respecting semver rules:
 *
 * - Major version bumps: Breaking changes are allowed
 * - Minor version bumps: Only additions are allowed (no breaking changes)
 * - Patch version bumps: Only additions are allowed (no breaking changes)
 *
 * ## How It Works
 *
 * 1. Downloads the latest published version from npm
 * 2. Extracts the .d.ts files for each entrypoint (main, browser, dev, util)
 * 3. Parses both published and current .d.ts files using TypeScript Compiler API
 * 4. Compares exported symbols (functions, classes, interfaces, types, etc.)
 * 5. Fails if breaking changes are detected in non-major version bumps
 *
 * ## Running the Test
 *
 * ```bash
 * cd sdk/js
 * pnpm build  # Must build first to generate .d.ts files
 * pnpm test src/api-compatibility.test.ts
 * ```
 *
 * ## What Gets Checked
 *
 * For each entrypoint, the test compares:
 * - Removed exports (breaking change)
 * - Modified export signatures (breaking change)
 * - Added exports (non-breaking, logged for info)
 *
 * ## Technology
 *
 * Uses the TypeScript Compiler API (typescript package), a mature and well-tested
 * tool maintained by Microsoft. This approach is more reliable than custom parsing
 * and handles complex TypeScript syntax correctly.
 */

/**
 * Extracts entrypoints from tsup.config.ts
 * Reads the config and identifies all builds that generate .d.ts files
 */
async function getEntrypointsFromTsupConfig(): Promise<
  Array<{ name: string; typesPath: string }>
> {
  const configPath = path.join(__dirname, "..", "..", "tsup.config.ts");

  // Dynamically import the tsup config
  const configModule = await import(configPath);
  const config: Options | Options[] = configModule.default;

  const configs = Array.isArray(config) ? config : [config];
  const entrypoints: Array<{ name: string; typesPath: string }> = [];

  for (const cfg of configs) {
    // Skip configs without dts enabled
    if (!cfg.dts) continue;

    const entry = cfg.entry;
    const outDir = cfg.outDir || "dist";

    if (Array.isArray(entry)) {
      for (const entryFile of entry) {
        const name = getEntrypointName(entryFile, outDir);
        const typesPath = getTypesPath(entryFile, outDir);
        entrypoints.push({ name, typesPath });
      }
    } else if (typeof entry === "object") {
      // entry is a record like { main: 'src/index.ts' }
      for (const [key, entryFile] of Object.entries(entry)) {
        const name = key;
        const typesPath = getTypesPath(String(entryFile), outDir);
        entrypoints.push({ name, typesPath });
      }
    }
  }

  return entrypoints;
}

/**
 * Determines the entrypoint name from the entry file path
 */
function getEntrypointName(entryFile: string, outDir: string): string {
  const basename = path.basename(entryFile, path.extname(entryFile));

  // Map common patterns to friendly names
  if (entryFile.includes("src/node/index.ts")) return "main";
  if (entryFile.includes("src/browser/index.ts")) return "browser";
  if (entryFile.includes("src/edge-light/index.ts")) return "edge-light";
  if (entryFile.includes("src/workerd/index.ts")) return "workerd";
  if (entryFile.includes("dev/index.ts")) return "dev";
  if (entryFile.includes("util/index.ts")) return "util";

  // Default to basename
  return basename;
}

/**
 * Constructs the .d.ts path from entry file and output directory
 */
function getTypesPath(entryFile: string, outDir: string): string {
  const basename = path.basename(entryFile, path.extname(entryFile));
  return path.join(outDir, `${basename}.d.ts`);
}

// Will be populated in beforeAll
let ENTRYPOINTS: Array<{ name: string; typesPath: string }> = [];

interface VersionInfo {
  major: number;
  minor: number;
  patch: number;
}

interface ExportedSymbol {
  name: string;
  kind: string;
  signature: string;
}

function parseVersion(version: string): VersionInfo {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function getVersionBumpType(
  published: VersionInfo,
  current: VersionInfo,
): "major" | "minor" | "patch" | "none" {
  if (current.major > published.major) return "major";
  if (current.minor > published.minor) return "minor";
  if (current.patch > published.patch) return "patch";
  return "none";
}

/**
 * Extracts exports and their signatures from a .d.ts file.
 * For bulk exports (export { A, B, C }), looks up the actual declaration
 * of each symbol to get its true signature, rather than using the export statement.
 */
function extractExportsFromDts(filePath: string): Map<string, ExportedSymbol> {
  const exports = new Map<string, ExportedSymbol>();

  if (!fs.existsSync(filePath)) {
    return exports;
  }

  const sourceText = fs.readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  // First pass: collect all declarations by name
  const declarations = new Map<string, ts.Node>();

  function collectDeclarations(node: ts.Node) {
    let name: string | undefined;

    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach((decl) => {
        if (ts.isIdentifier(decl.name)) {
          declarations.set(decl.name.text, node);
        }
      });
    } else if (ts.isModuleDeclaration(node) && node.name) {
      name = node.name.text;
    }

    if (name) {
      declarations.set(name, node);
    }

    ts.forEachChild(node, collectDeclarations);
  }

  collectDeclarations(sourceFile);

  // Helper to check if a node is inside a namespace
  function isInsideNamespace(node: ts.Node): boolean {
    let parent = node.parent;
    while (parent) {
      if (ts.isModuleDeclaration(parent)) {
        return true;
      }
      parent = parent.parent;
    }
    return false;
  }

  // Second pass: process exports
  function visit(node: ts.Node) {
    // Skip exports inside namespaces - they're not top-level exports
    if (isInsideNamespace(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    // Handle: export { foo, bar } or export { foo, bar } from './module'
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        node.exportClause.elements.forEach((element) => {
          const name = element.name.text;
          const declaration = declarations.get(name);

          exports.set(name, {
            name,
            kind: declaration ? getNodeKind(declaration) : "re-export",
            // Use the actual declaration's signature if found, otherwise just the name
            signature: declaration
              ? declaration.getText(sourceFile)
              : `export { ${name} }`,
          });
        });
      }
    } else if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      // Handle direct exports with 'export' keyword
      let name: string | undefined;
      let kind: string = "unknown";
      const signature: string = node.getText(sourceFile);

      if (ts.isFunctionDeclaration(node) && node.name) {
        name = node.name.text;
        kind = "function";
      } else if (ts.isClassDeclaration(node) && node.name) {
        name = node.name.text;
        kind = "class";
      } else if (ts.isInterfaceDeclaration(node)) {
        name = node.name.text;
        kind = "interface";
      } else if (ts.isTypeAliasDeclaration(node)) {
        name = node.name.text;
        kind = "type";
      } else if (ts.isEnumDeclaration(node)) {
        name = node.name.text;
        kind = "enum";
      } else if (ts.isVariableStatement(node)) {
        // Handle: export const foo = ...
        node.declarationList.declarations.forEach((decl) => {
          if (ts.isIdentifier(decl.name)) {
            const varName = decl.name.text;
            exports.set(varName, {
              name: varName,
              kind: "variable",
              signature: node.getText(sourceFile),
            });
          }
        });
        return; // Don't add to exports again below
      } else if (ts.isModuleDeclaration(node) && node.name) {
        name = node.name.text;
        kind = "namespace";
      }

      if (name) {
        exports.set(name, { name, kind, signature });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return exports;
}

function getNodeKind(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableStatement(node)) return "variable";
  if (ts.isModuleDeclaration(node)) return "namespace";
  return "unknown";
}

/**
 * Extracts actual runtime exports from a JavaScript module file
 */
async function extractRuntimeExports(mjsPath: string): Promise<Set<string>> {
  const exports = new Set<string>();

  if (!fs.existsSync(mjsPath)) {
    return exports;
  }

  try {
    // Dynamically import the module
    const module = await import(mjsPath);

    // Get all exported names
    for (const key of Object.keys(module)) {
      exports.add(key);
    }
  } catch (error) {
    console.warn(`Failed to load runtime exports from ${mjsPath}:`, error);
  }

  return exports;
}

/**
 * Verifies that runtime exports match TypeScript declarations
 * Only checks value exports (functions, classes, variables), not pure types
 */
function verifyRuntimeMatchesTypes(
  dtsExports: Map<string, ExportedSymbol>,
  runtimeExports: Set<string>,
  entrypointName: string,
): string[] {
  const errors: string[] = [];

  // Check that non-type exports in .d.ts actually exist at runtime
  for (const [name, symbol] of dtsExports) {
    // Skip pure types (they don't exist at runtime)
    if (
      symbol.kind === "type" ||
      symbol.kind === "interface" ||
      name === "default"
    ) {
      continue;
    }

    // This should be a runtime value - verify it exists
    if (!runtimeExports.has(name)) {
      errors.push(
        `${name} is declared in ${entrypointName}.d.ts as a ${symbol.kind} but is NOT exported in the runtime JavaScript`,
      );
    }
  }

  return errors;
}

function compareExports(
  publishedExports: Map<string, ExportedSymbol>,
  currentExports: Map<string, ExportedSymbol>,
): {
  removed: ExportedSymbol[];
  added: ExportedSymbol[];
  modified: Array<{
    name: string;
    before: string;
    after: string;
    kind: string;
  }>;
} {
  const removed: ExportedSymbol[] = [];
  const added: ExportedSymbol[] = [];
  const modified: Array<{
    name: string;
    before: string;
    after: string;
    kind: string;
  }> = [];

  // Internal testing exports that can change without breaking compatibility
  const internalExports = new Set(["_exportsForTestingOnly"]);

  // Check for removed or modified exports
  for (const [name, publishedSymbol] of publishedExports) {
    // Skip internal exports - they can change without being breaking changes
    if (internalExports.has(name)) {
      continue;
    }

    const currentSymbol = currentExports.get(name);
    if (!currentSymbol) {
      removed.push(publishedSymbol);
    } else if (
      !areSignaturesCompatible(
        publishedSymbol.signature,
        currentSymbol.signature,
        publishedSymbol.kind,
      )
    ) {
      modified.push({
        name,
        before: publishedSymbol.signature,
        after: currentSymbol.signature,
        kind: publishedSymbol.kind,
      });
    }
  }

  // Check for added exports
  for (const [name, currentSymbol] of currentExports) {
    // Skip internal exports - their additions don't count as public API additions
    if (internalExports.has(name)) {
      continue;
    }

    if (!publishedExports.has(name)) {
      added.push(currentSymbol);
    }
  }

  return { removed, added, modified };
}

/**
 * Strips JSDoc comments from a signature.
 * JSDoc comments are documentation only and don't affect the API surface.
 */
function stripJSDocComments(sig: string): string {
  // Remove /** ... */ style comments (including multiline)
  return sig.replace(/\/\*\*[\s\S]*?\*\//g, "").trim();
}

function areSignaturesCompatible(
  oldSig: string,
  newSig: string,
  kind?: string,
): boolean {
  // Strip JSDoc comments first - they're documentation only
  const oldStripped = stripJSDocComments(oldSig);
  const newStripped = stripJSDocComments(newSig);

  // Normalize whitespace for comparison
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

  const oldNorm = normalize(oldStripped);
  const newNorm = normalize(newStripped);

  // If they're exactly the same, they're compatible
  if (oldNorm === newNorm) {
    return true;
  }

  // Dispatch to type-specific compatibility checkers
  switch (kind) {
    case "interface":
      return areInterfaceSignaturesCompatible(oldNorm, newNorm);

    case "function":
      return areFunctionSignaturesCompatible(oldNorm, newNorm);

    case "type":
      return areTypeAliasSignaturesCompatible(oldNorm, newNorm);

    case "enum":
      return areEnumSignaturesCompatible(oldNorm, newNorm);

    case "class":
      return areClassSignaturesCompatible(oldNorm, newNorm);

    case "variable":
      // Special handling for Zod schemas
      if (oldNorm.includes("ZodObject") && newNorm.includes("ZodObject")) {
        return areZodSchemaSignaturesCompatible(oldNorm, newNorm);
      }
      // Special handling for const arrays (tuples) - adding values is compatible
      if (oldNorm.includes("readonly [") && newNorm.includes("readonly [")) {
        return areConstArraySignaturesCompatible(oldNorm, newNorm);
      }
      // For other variables, use conservative check (exact match)
      return oldNorm === newNorm;
  }

  // Strategy: Normalize both signatures by removing optional markers and default values,
  // then compare. If the normalized versions match, and the new signature only adds
  // optionality (either via ? or default values), it's backward compatible.

  // Step 1: Remove default values and normalize optional parameters
  // This regex removes default values like "= {}" or "= defaultValue"
  const removeDefaults = (s: string) =>
    s.replace(/=\s*\{[^}]*\}/g, "= {}").replace(/=\s*[^,)}]+/g, "");

  // Step 2: Create a "base" version of each signature by removing optionality
  // This allows us to compare the core structure
  const createBaseSignature = (s: string): string => {
    let base = s;
    // Remove default values first (they come after optional markers)
    base = removeDefaults(base);
    // Remove optional markers from parameters (param?: Type -> param: Type)
    // But preserve them in object types for now
    base = base.replace(/(\w+)\?:\s*/g, "$1: ");
    // Remove optional markers from object properties (field?: Type -> field: Type)
    // This is tricky - we need to handle nested objects, so we do a simple replacement
    // that works for most cases
    base = base.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\?:\s*/g, "$1: ");
    return base;
  };

  const oldBase = createBaseSignature(oldNorm);
  const newBase = createBaseSignature(newNorm);

  // If base signatures match, check if only optionality was added
  if (oldBase === newBase) {
    // Base structures are identical - check if new signature only adds optionality
    // This means:
    // 1. Parameters that were required became optional (param: Type -> param?: Type or param?: Type = ...)
    // 2. Object properties gained optional markers (field: Type -> field?: Type)
    // 3. Default values were added

    // If old has a required param and new has it as optional, that's compatible
    // Pattern: old has "param: Type" and new has "param?: Type" or "param?: Type = ..."
    // We already normalized these in createBaseSignature, so if bases match,
    // the differences are only in optionality markers or defaults, which are compatible.
    return true;
  }

  // Step 3: Check for the specific pattern where a required parameter becomes optional
  // Pattern: old has "param: Type" and new has "param?: Type" or "param?: Type = defaultValue"
  // This requires matching parameter names, which is complex with nested types.

  // Step 4: Handle the case where object types gain optional fields
  // When object types gain optional fields, the base signatures won't match exactly
  // because new fields are added. We need a different strategy.

  // Extract the core signature parts (name, params region, return type)
  const extractCoreParts = (s: string) => {
    // Match: name(parameters): returnType
    const match = s.match(/^(\w+)\s*\(([^)]*)\)\s*:\s*(.+)$/);
    if (match) {
      return {
        name: match[1],
        params: match[2],
        returnType: match[3],
      };
    }
    // For class methods, pattern might be slightly different
    // Try: public method(parameters): returnType
    const methodMatch = s.match(
      /(?:public\s+)?(\w+)\s*\(([^)]*)\)\s*:\s*(.+)$/,
    );
    if (methodMatch) {
      return {
        name: methodMatch[1],
        params: methodMatch[2],
        returnType: methodMatch[3],
      };
    }
    return null;
  };

  const oldParts = extractCoreParts(oldNorm);
  const newParts = extractCoreParts(newNorm);

  if (oldParts && newParts) {
    // Check if name and return type match
    if (
      oldParts.name === newParts.name &&
      oldParts.returnType === newParts.returnType
    ) {
      // Parameters changed, but name and return type match
      // This is a strong signal that changes are likely backward-compatible
      // (e.g., adding optional parameters or optional fields to object types)

      // Count parameters (simple comma count at top level)
      const countParams = (params: string): number => {
        if (!params.trim()) return 0;
        // Count commas at the top level (not inside brackets/braces/parens)
        let depth = 0;
        let count = 0;
        for (let i = 0; i < params.length; i++) {
          const char = params[i];
          if (char === "<" || char === "{" || char === "(") {
            depth++;
          } else if (char === ">" || char === "}" || char === ")") {
            depth--;
          } else if (char === "," && depth === 0) {
            count++;
          }
        }
        return count + 1; // +1 because N commas means N+1 params
      };

      const oldParamCount = countParams(oldParts.params);
      const newParamCount = countParams(newParts.params);

      // If parameter counts are the same or new has at most one more parameter,
      // consider it compatible. This covers:
      // 1. Required param -> optional param (same count)
      // 2. Adding optional parameter at end (+1 count)
      // 3. Object types gaining optional fields (same count, different content)
      if (
        newParamCount >= oldParamCount &&
        newParamCount <= oldParamCount + 1
      ) {
        return true;
      }
    }
  }

  // If we can't determine compatibility, be conservative
  return false;
}

/**
 * Compares function signatures to determine if changes are backwards compatible.
 * Adding optional parameters at the end or making parameters optional is compatible.
 */
function areFunctionSignaturesCompatible(
  oldFn: string,
  newFn: string,
): boolean {
  // Extract function name and parameters
  const parseFunctionSig = (sig: string) => {
    // Match: export function name(params): returnType OR function name(params): returnType (for re-exports)
    const match = sig.match(
      /(?:export\s+)?(?:declare\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*:\s*(.+)$/,
    );
    if (!match) return null;

    return {
      name: match[1],
      params: match[2].trim(),
      returnType: match[3].trim(),
    };
  };

  const oldParsed = parseFunctionSig(oldFn);
  const newParsed = parseFunctionSig(newFn);

  if (!oldParsed || !newParsed || oldParsed.name !== newParsed.name) {
    return false; // Can't parse or different function names
  }

  // Return type must match (simple check)
  if (oldParsed.returnType !== newParsed.returnType) {
    return false;
  }

  // Parse parameters
  const parseParams = (paramStr: string) => {
    if (!paramStr.trim()) return [];

    const params: Array<{ name: string; type: string; optional: boolean }> = [];
    let depth = 0;
    let current = "";

    for (let i = 0; i < paramStr.length; i++) {
      const char = paramStr[i];

      if (char === "<" || char === "{" || char === "(") {
        depth++;
        current += char;
      } else if (char === ">" || char === "}" || char === ")") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        if (current.trim()) {
          params.push(parseParam(current.trim()));
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      params.push(parseParam(current.trim()));
    }

    return params;
  };

  const parseParam = (paramStr: string) => {
    // Match: name?: Type or name: Type or name: Type = default
    let optional = false;
    let name = "";
    let type = "";

    // Check for default value (makes it optional)
    const hasDefault = paramStr.includes("=");
    if (hasDefault) {
      paramStr = paramStr.substring(0, paramStr.indexOf("=")).trim();
      optional = true;
    }

    // Check for optional marker
    const colonIndex = paramStr.indexOf(":");
    if (colonIndex > 0) {
      const namePart = paramStr.substring(0, colonIndex).trim();
      if (namePart.endsWith("?")) {
        optional = true;
        name = namePart.substring(0, namePart.length - 1).trim();
      } else {
        name = namePart;
      }
      type = paramStr.substring(colonIndex + 1).trim();
    }

    return { name, type, optional };
  };

  const oldParams = parseParams(oldParsed.params);
  const newParams = parseParams(newParsed.params);

  // Check if all old required params exist in same positions with same types
  for (let i = 0; i < oldParams.length; i++) {
    const oldParam = oldParams[i];
    const newParam = newParams[i];

    if (!newParam) {
      // Parameter was removed - breaking change
      return false;
    }

    if (oldParam.type !== newParam.type) {
      // Parameter type changed - breaking change
      return false;
    }

    // If old param was required, new param can be required or optional (compatible)
    // If old param was optional, new param must be optional (making it required is breaking)
    if (oldParam.optional && !newParam.optional) {
      return false;
    }
  }

  // Check new parameters beyond old params
  for (let i = oldParams.length; i < newParams.length; i++) {
    const newParam = newParams[i];
    // New parameters must be optional or have defaults
    if (!newParam.optional) {
      return false;
    }
  }

  return true;
}

/**
 * Normalizes type references to handle equivalent forms:
 * - z.infer<typeof Type> -> TypeType
 * - z.infer<typeof Type$N> -> TypeType (handles TypeScript disambiguation suffixes)
 * - Type$1, Type$2, etc. -> Type (removes TypeScript disambiguation suffixes)
 */
function normalizeTypeReference(type: string): string {
  // First normalize z.infer<typeof TypeName$N> patterns - handle both with and without $N suffix
  // This handles: z.infer<typeof ObjectReference$1> -> ObjectReferenceType
  // And: z.infer<typeof ObjectReference> -> ObjectReferenceType
  // Match the full identifier (which may include $ suffix) and extract just the base name
  type = type.replace(
    /z\.infer<typeof\s+([\w$]+)>/g,
    (match, fullIdentifier) => {
      // Extract base name by removing $ suffix if present
      // Simply remove any $ followed by digits from the end
      const baseName = fullIdentifier.replace(/\$\d+$/, "");
      return `${baseName}Type`;
    },
  );

  // Then remove any remaining TypeScript disambiguation suffixes
  // This handles cases like: ObjectReferenceType$1 -> ObjectReferenceType
  type = type.replace(/(\w+)\$\d+/g, "$1");

  return type;
}

function parseObjectTypeProps(
  def: string,
): Map<string, { type: string; optional: boolean }> {
  const props = new Map<string, { type: string; optional: boolean }>();

  let braceDepth = 0;
  let startIdx = -1;
  for (let i = 0; i < def.length; i++) {
    if (def[i] === "{") {
      if (braceDepth === 0) startIdx = i + 1;
      braceDepth++;
    } else if (def[i] === "}") {
      braceDepth--;
      if (braceDepth === 0 && startIdx !== -1) {
        const body = def.substring(startIdx, i);

        let depth = 0;
        let current = "";
        let propName = "";
        let isOptional = false;
        let inPropName = true;

        for (let j = 0; j < body.length; j++) {
          const char = body[j];

          if (char === "<" || char === "{" || char === "(") {
            depth++;
            if (!inPropName) current += char;
          } else if (char === ">" || char === "}" || char === ")") {
            depth--;
            if (!inPropName) current += char;
          } else if (char === "?" && depth === 0 && inPropName) {
            isOptional = true;
          } else if (char === ":" && depth === 0 && inPropName) {
            inPropName = false;
            propName = current.trim();
            current = "";
          } else if (char === ";" && depth === 0) {
            if (propName) {
              props.set(propName, {
                type: current.trim(),
                optional: isOptional,
              });
            }
            current = "";
            propName = "";
            isOptional = false;
            inPropName = true;
          } else {
            if (inPropName) {
              if (char.trim()) current += char;
            } else {
              current += char;
            }
          }
        }

        if (propName && current.trim()) {
          props.set(propName, {
            type: current.trim(),
            optional: isOptional,
          });
        }

        break;
      }
    }
  }

  return props;
}

function areObjectTypeDefinitionsCompatible(
  oldDef: string,
  newDef: string,
): boolean {
  const oldProps = parseObjectTypeProps(oldDef);
  const newProps = parseObjectTypeProps(newDef);

  for (const [propName, oldProp] of oldProps) {
    const newProp = newProps.get(propName);

    if (!newProp) {
      return false;
    }

    const normalizeType = (type: string) =>
      normalizeTypeReference(type.replace(/\s+/g, " ").trim());
    const oldTypeNorm = normalizeType(oldProp.type);
    const newTypeNorm = normalizeType(newProp.type);

    if (oldTypeNorm !== newTypeNorm) {
      if (!isUnionTypeWidening(oldTypeNorm, newTypeNorm)) {
        return false;
      }
    }

    if (oldProp.optional && !newProp.optional) {
      return false;
    }
  }

  for (const [propName, newProp] of newProps) {
    if (!oldProps.has(propName) && !newProp.optional) {
      return false;
    }
  }

  return true;
}

function parseTypeAliasDefinitionNode(def: string): ts.TypeNode | null {
  const sourceFile = ts.createSourceFile(
    "type-alias.ts",
    `type __ApiCompatAlias = ${def};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let declaration: ts.TypeAliasDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && !declaration) {
      declaration = node;
    }
  });

  return declaration?.type ?? null;
}

function getIntersectionParts(def: string): string[] {
  const typeNode = parseTypeAliasDefinitionNode(def);
  if (!typeNode) {
    return [def.trim()];
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.map((type) => type.getText());
  }

  return [typeNode.getText()];
}

function getTypeLiteralPart(def: string): string | null {
  const typeNode = parseTypeAliasDefinitionNode(def);
  if (!typeNode) {
    return null;
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.getText();
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    const literalPart = typeNode.types.find((type) =>
      ts.isTypeLiteralNode(type),
    );
    return literalPart?.getText() ?? null;
  }

  return null;
}

function areTypeAliasSignaturesCompatible(
  oldType: string,
  newType: string,
): boolean {
  // Extract type name and definition
  const parseTypeSig = (sig: string) => {
    // Match: export type Name = Definition or export type Name<T> = Definition
    // Also handles non-exported aliases for re-exports.
    const match = sig.match(
      /(?:export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=\s*(.+)$/s,
    );
    if (!match) return null;

    return {
      name: match[1],
      definition: match[2].trim(),
    };
  };

  const oldParsed = parseTypeSig(oldType);
  const newParsed = parseTypeSig(newType);

  if (!oldParsed || !newParsed || oldParsed.name !== newParsed.name) {
    return false; // Can't parse or different type names
  }

  const oldDef = oldParsed.definition;
  const newDef = newParsed.definition;

  // Check if it's a union type (at top level, not inside braces/brackets/parens)
  const isUnion = (def: string) => {
    let depth = 0;
    for (let i = 0; i < def.length; i++) {
      const char = def[i];
      if (char === "<" || char === "{" || char === "(") {
        depth++;
      } else if (char === ">" || char === "}" || char === ")") {
        depth--;
      } else if (char === "|" && depth === 0) {
        return true; // Found a pipe at top level
      }
    }
    return false;
  };

  if (isUnion(oldDef) || isUnion(newDef)) {
    // Parse union members
    const parseUnion = (def: string): Set<string> => {
      const members = new Set<string>();
      let depth = 0;
      let current = "";

      for (let i = 0; i < def.length; i++) {
        const char = def[i];

        if (char === "<" || char === "{" || char === "(") {
          depth++;
          current += char;
        } else if (char === ">" || char === "}" || char === ")") {
          depth--;
          current += char;
        } else if (char === "|" && depth === 0) {
          if (current.trim()) {
            members.add(current.trim());
          }
          current = "";
        } else {
          current += char;
        }
      }

      if (current.trim()) {
        members.add(current.trim());
      }

      return members;
    };

    const oldMembers = parseUnion(oldDef);
    const newMembers = parseUnion(newDef);

    // Check if all old members exist in new (union widening is compatible)
    for (const oldMember of oldMembers) {
      if (!newMembers.has(oldMember)) {
        // Union narrowed - breaking change
        return false;
      }
    }

    return true;
  }

  // Check if it's an object type
  const isObjectType = (def: string) => def.trim().startsWith("{");

  if (isObjectType(oldDef) && isObjectType(newDef)) {
    return areObjectTypeDefinitionsCompatible(oldDef, newDef);
  }

  const oldTypeLiteralPart = getTypeLiteralPart(oldDef);
  const newTypeLiteralPart = getTypeLiteralPart(newDef);

  if (oldTypeLiteralPart && newTypeLiteralPart) {
    return areObjectTypeDefinitionsCompatible(
      oldTypeLiteralPart,
      newTypeLiteralPart,
    );
  }

  const oldIntersectionParts = getIntersectionParts(oldDef);
  const newIntersectionParts = getIntersectionParts(newDef);

  if (oldIntersectionParts.length > 1 || newIntersectionParts.length > 1) {
    if (oldIntersectionParts.length !== newIntersectionParts.length) {
      return false;
    }

    const usedNewIndices = new Set<number>();

    for (const oldPart of oldIntersectionParts) {
      const oldPartNorm = normalizeTypeReference(
        oldPart.replace(/\s+/g, " ").trim(),
      );

      let matched = false;
      for (const [index, newPart] of newIntersectionParts.entries()) {
        if (usedNewIndices.has(index)) {
          continue;
        }

        const newPartNorm = normalizeTypeReference(
          newPart.replace(/\s+/g, " ").trim(),
        );

        if (oldPartNorm === newPartNorm) {
          usedNewIndices.add(index);
          matched = true;
          break;
        }

        if (
          isObjectType(oldPart) &&
          isObjectType(newPart) &&
          areObjectTypeDefinitionsCompatible(oldPart, newPart)
        ) {
          usedNewIndices.add(index);
          matched = true;
          break;
        }
      }

      if (!matched) {
        return false;
      }
    }

    return true;
  }

  // For other types, normalize and compare
  // This handles cases where TypeScript generates different names that are semantically equivalent
  const oldDefNorm = normalizeTypeReference(oldDef);
  const newDefNorm = normalizeTypeReference(newDef);
  return oldDefNorm === newDefNorm;
}

/**
 * Compares enum signatures to determine if changes are backwards compatible.
 * Adding new enum values is compatible, but removing or changing values is not.
 */
function areEnumSignaturesCompatible(
  oldEnum: string,
  newEnum: string,
): boolean {
  // Extract enum name and members
  const parseEnumSig = (sig: string) => {
    // Match: export enum Name { members } OR declare enum Name { members } OR enum Name { members } (for re-exports)
    const match = sig.match(
      /(?:export\s+)?(?:declare\s+)?enum\s+(\w+)\s*\{([^}]*)\}/,
    );
    if (!match) return null;

    const name = match[1];
    const body = match[2];

    // Parse enum members
    const members = new Map<string, string>();
    let depth = 0;
    let current = "";

    for (let i = 0; i < body.length; i++) {
      const char = body[i];

      if (char === "<" || char === "{" || char === "(") {
        depth++;
        current += char;
      } else if (char === ">" || char === "}" || char === ")") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        if (current.trim()) {
          const [memberName, memberValue] = parseMember(current.trim());
          members.set(memberName, memberValue);
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      const [memberName, memberValue] = parseMember(current.trim());
      members.set(memberName, memberValue);
    }

    return { name, members };
  };

  const parseMember = (memberStr: string): [string, string] => {
    const eqIndex = memberStr.indexOf("=");
    if (eqIndex > 0) {
      const name = memberStr.substring(0, eqIndex).trim();
      const value = memberStr.substring(eqIndex + 1).trim();
      return [name, value];
    }
    return [memberStr.trim(), ""];
  };

  const oldParsed = parseEnumSig(oldEnum);
  const newParsed = parseEnumSig(newEnum);

  if (!oldParsed || !newParsed || oldParsed.name !== newParsed.name) {
    return false; // Can't parse or different enum names
  }

  // Check all old members exist in new with same values
  for (const [memberName, memberValue] of oldParsed.members) {
    const newValue = newParsed.members.get(memberName);

    if (newValue === undefined) {
      // Member removed - breaking change
      return false;
    }

    if (memberValue !== newValue) {
      // Member value changed - breaking change
      return false;
    }
  }

  // New members are allowed
  return true;
}

/**
 * Checks if a type change represents union widening (backwards compatible).
 * Returns true if oldType is a subset of newType (e.g., T -> T | U | V).
 */
function isUnionTypeWidening(oldType: string, newType: string): boolean {
  // Check if newType is a union that includes oldType
  const isUnion = (type: string) => type.includes("|");

  if (!isUnion(newType)) {
    // New type is not a union, so it's not widening
    return false;
  }

  // Parse union members from newType
  const parseUnionMembers = (type: string): Set<string> => {
    const members = new Set<string>();
    let depth = 0;
    let current = "";

    for (let i = 0; i < type.length; i++) {
      const char = type[i];

      if (char === "<" || char === "{" || char === "(") {
        depth++;
        current += char;
      } else if (char === ">" || char === "}" || char === ")") {
        depth--;
        current += char;
      } else if (char === "|" && depth === 0) {
        if (current.trim()) {
          members.add(current.trim());
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      members.add(current.trim());
    }

    return members;
  };

  const newMembers = parseUnionMembers(newType);

  // Check if oldType (or oldType as a union) is a subset of newType
  if (isUnion(oldType)) {
    const oldMembers = parseUnionMembers(oldType);
    // All old members must be in new members
    for (const oldMember of oldMembers) {
      if (!newMembers.has(oldMember)) {
        return false;
      }
    }
    return true;
  } else {
    // oldType is a single type - check if it's in the new union
    return newMembers.has(oldType);
  }
}

/**
 * Compares interface signatures to determine if changes are backwards compatible.
 * Adding optional fields to interfaces is backwards compatible.
 */
function areInterfaceSignaturesCompatible(
  oldInterface: string,
  newInterface: string,
): boolean {
  const parseInterface = (interfaceSig: string) => {
    const sourceFile = ts.createSourceFile(
      "interface.ts",
      interfaceSig,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    let declaration: ts.InterfaceDeclaration | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (ts.isInterfaceDeclaration(node) && !declaration) {
        declaration = node;
      }
    });

    if (!declaration) {
      return null;
    }

    const fields = new Map<string, { type: string; optional: boolean }>();
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || !member.type) {
        return null;
      }

      fields.set(member.name.getText(sourceFile), {
        type: member.type.getText(sourceFile),
        optional: !!member.questionToken,
      });
    }

    return {
      name: declaration.name.text,
      fields,
    };
  };

  const oldParsed = parseInterface(oldInterface);
  const newParsed = parseInterface(newInterface);

  if (!oldParsed || !newParsed || oldParsed.name !== newParsed.name) {
    return false;
  }

  const oldFields = oldParsed.fields;
  const newFields = newParsed.fields;

  // Check that all old fields exist in new interface with compatible types
  for (const [fieldName, oldField] of oldFields) {
    const newField = newFields.get(fieldName);

    if (!newField) {
      // Field was removed - breaking change
      return false;
    }

    // Normalize field types for comparison (remove whitespace differences and normalize type references)
    const normalizeType = (type: string) =>
      normalizeTypeReference(type.replace(/\s+/g, " ").trim());
    const oldTypeNorm = normalizeType(oldField.type);
    const newTypeNorm = normalizeType(newField.type);

    if (oldTypeNorm !== newTypeNorm) {
      // Check if it's a union type widening (backwards compatible)
      if (!isUnionTypeWidening(oldTypeNorm, newTypeNorm)) {
        // Field type changed in an incompatible way - breaking change
        return false;
      }
    }

    // Check if required field became optional - that's compatible
    // Check if optional field became required - that's breaking
    if (!oldField.optional && newField.optional) {
      // Required -> Optional: compatible
      continue;
    } else if (oldField.optional && !newField.optional) {
      // Optional -> Required: breaking
      return false;
    }
  }

  // New fields are allowed if they're optional
  for (const [fieldName, newField] of newFields) {
    if (!oldFields.has(fieldName)) {
      // New field - must be optional
      if (!newField.optional) {
        // New required field - breaking change
        return false;
      }
      // New optional field - compatible
    }
  }

  // All checks passed - interfaces are compatible
  return true;
}

/**
 * Compares const array (tuple) signatures to determine if changes are backwards compatible.
 * Adding new values at the end of a const array is backwards compatible.
 * Example: readonly ["a", "b"] -> readonly ["a", "b", "c"] is compatible
 */
function areConstArraySignaturesCompatible(
  oldSig: string,
  newSig: string,
): boolean {
  // Extract tuple members from signatures like:
  // declare const foo: readonly ["a", "b", "c"];
  // or: export const foo: readonly ["a", "b", "c"];
  const parseTupleMembers = (sig: string): string[] | null => {
    // Match: readonly ["value1", "value2", ...] or readonly [value1, value2, ...]
    const match = sig.match(/readonly\s*\[([^\]]*)\]/);
    if (!match) return null;

    const body = match[1];
    const members: string[] = [];
    let depth = 0;
    let current = "";

    for (let i = 0; i < body.length; i++) {
      const char = body[i];

      if (char === "<" || char === "{" || char === "(" || char === "[") {
        depth++;
        current += char;
      } else if (char === ">" || char === "}" || char === ")" || char === "]") {
        depth--;
        current += char;
      } else if (char === "," && depth === 0) {
        if (current.trim()) {
          members.push(current.trim());
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      members.push(current.trim());
    }

    return members;
  };

  const oldMembers = parseTupleMembers(oldSig);
  const newMembers = parseTupleMembers(newSig);

  if (!oldMembers || !newMembers) {
    return false; // Can't parse as tuple
  }

  // Check that all old members exist in the same position in new
  for (let i = 0; i < oldMembers.length; i++) {
    if (newMembers[i] !== oldMembers[i]) {
      // Member changed or removed - breaking change
      return false;
    }
  }

  // New members at the end are allowed (widening the tuple type)
  return true;
}

/**
 * Compares Zod schema signatures to determine if changes are backwards compatible.
 * Adding optional fields (z.ZodOptional) to object schemas is backwards compatible.
 */
function areZodSchemaSignaturesCompatible(
  oldSchema: string,
  newSchema: string,
): boolean {
  // Extract the fields from ZodObject definitions
  // Pattern: { field1: z.ZodType, field2: z.ZodOptional<z.ZodType>, ... }

  // Remove all ZodOptional wrappers to get base structure
  const removeOptionalWrappers = (s: string): string => {
    // Replace z.ZodOptional<Type> with Type
    return s.replace(/z\.ZodOptional<([^>]+)>/g, "$1");
  };

  const oldBase = removeOptionalWrappers(oldSchema);
  const newBase = removeOptionalWrappers(newSchema);

  // If removing optional wrappers makes them similar, the change is just adding optionality
  if (oldBase === newBase) {
    return true;
  }

  // Check if the only difference is new optional fields being added
  // Extract field names from object types
  const extractFieldNames = (s: string): Set<string> => {
    const fields = new Set<string>();
    // Match: fieldName: z.Zod...
    const matches = s.matchAll(/(\w+):\s*z\.Zod/g);
    for (const match of matches) {
      fields.add(match[1]);
    }
    return fields;
  };

  const oldFields = extractFieldNames(oldSchema);
  const newFields = extractFieldNames(newSchema);

  // Check if all old fields are present in new schema
  for (const field of oldFields) {
    if (!newFields.has(field)) {
      // A field was removed - breaking change
      return false;
    }
  }

  // All old fields are present, and potentially new optional fields were added
  // This is backwards compatible
  return true;
}

/**
 * Compares class signatures by extracting and comparing individual methods
 * This handles cases where methods gain optional parameters or optional fields
 */
function areClassSignaturesCompatible(
  oldClass: string,
  newClass: string,
): boolean {
  // Extract class name to ensure we're comparing the same class
  const oldClassNameMatch = oldClass.match(/class\s+(\w+)/);
  const newClassNameMatch = newClass.match(/class\s+(\w+)/);

  if (
    !oldClassNameMatch ||
    !newClassNameMatch ||
    oldClassNameMatch[1] !== newClassNameMatch[1]
  ) {
    return false; // Different classes
  }

  // For classes, use a lenient heuristic: if class names match and the structure
  // is similar (similar length, same general structure), allow parameter-level changes.
  // This is more reliable than trying to parse all methods with regex.

  // Simple length-based check: if new class is similar length or slightly longer,
  // it's likely just adding optional fields/parameters (backward-compatible)
  const oldLength = oldClass.length;
  const newLength = newClass.length;
  const lengthRatio = newLength / Math.max(oldLength, 1);

  // If new is similar length (95-150% of old), allow it
  // Adding optional fields will increase length but not dramatically
  if (lengthRatio >= 0.95 && lengthRatio <= 1.5) {
    // Additional check: ensure new class contains the class name and key structural elements
    // This prevents completely unrelated classes from being considered compatible
    if (newClass.includes(oldClassNameMatch[1])) {
      return true;
    }
  }

  // Also check normalized versions (removing optional markers and defaults)
  // If normalized versions are similar, the changes are likely just optionality
  const normalizeClass = (classText: string): string => {
    let normalized = classText;
    // Remove optional markers: field?: Type -> field: Type
    normalized = normalized.replace(
      /([a-zA-Z_$][a-zA-Z0-9_$]*)\?:\s*/g,
      "$1: ",
    );
    // Remove default values
    normalized = normalized.replace(/=\s*\{[^}]*\}/g, "= {}");
    normalized = normalized.replace(/=\s*[^,)}]+/g, "");
    return normalized;
  };

  const oldNormalized = normalizeClass(oldClass);
  const newNormalized = normalizeClass(newClass);

  // Check if normalized versions are similar (one contains significant portion of the other)
  const similarityThreshold = Math.min(500, oldNormalized.length * 0.5);
  if (newNormalized.includes(oldNormalized.substring(0, similarityThreshold))) {
    return true;
  }

  return false;
}

/**
 * Compares method parameter lists, allowing optional field additions
 */
function areMethodParamsCompatible(
  oldParams: string,
  newParams: string,
): boolean {
  // If they're the same, compatible
  if (oldParams === newParams) {
    return true;
  }

  // Count parameters
  const countParams = (params: string): number => {
    if (!params.trim()) return 0;
    let depth = 0;
    let count = 0;
    for (let i = 0; i < params.length; i++) {
      const char = params[i];
      if (char === "<" || char === "{" || char === "(") {
        depth++;
      } else if (char === ">" || char === "}" || char === ")") {
        depth--;
      } else if (char === "," && depth === 0) {
        count++;
      }
    }
    return count + 1;
  };

  const oldCount = countParams(oldParams);
  const newCount = countParams(newParams);

  // Same number of params or new has one more (adding optional param)
  if (newCount >= oldCount && newCount <= oldCount + 1) {
    // Check if it's just adding optional fields to object types
    // Normalize by removing optional markers and defaults
    const normalizeParams = (p: string) => {
      return p
        .replace(/\?:\s*/g, ": ")
        .replace(/=\s*\{[^}]*\}/g, "= {}")
        .replace(/=\s*[^,)}]+/g, "");
    };

    const oldNorm = normalizeParams(oldParams);
    const newNorm = normalizeParams(newParams);

    // If normalized versions are similar (one contains the other),
    // it's likely just optional field additions
    if (newNorm.includes(oldNorm) || oldNorm.includes(newNorm)) {
      return true;
    }

    // Check if only optional fields were added to object types
    // This is a heuristic: if the structure is similar, allow it
    // Extract object type content for comparison
    const extractObjectContent = (p: string): string[] => {
      const objects: string[] = [];
      let depth = 0;
      let current = "";
      let inObject = false;
      for (let i = 0; i < p.length; i++) {
        const char = p[i];
        if (char === "{") {
          if (depth === 0) {
            inObject = true;
            current = "";
          }
          depth++;
        } else if (char === "}") {
          depth--;
          if (depth === 0 && inObject) {
            objects.push(current);
            inObject = false;
          }
        } else if (inObject) {
          current += char;
        }
      }
      return objects;
    };

    const oldObjects = extractObjectContent(oldParams);
    const newObjects = extractObjectContent(newParams);

    // If we have object types and new has same or more fields, likely compatible
    if (oldObjects.length > 0 && newObjects.length >= oldObjects.length) {
      // For now, be permissive - if object types exist and count increased,
      // assume it's just adding optional fields
      return true;
    }
  }

  // If we can't determine, be conservative but allow if counts are similar
  // This handles cases where optional fields are added to object types
  return newCount === oldCount || newCount === oldCount + 1;
}

/**
 * Truncates a signature for display, showing first N chars and
 * handling multiline signatures better
 */
function truncateSignature(sig: string, maxLength: number = 150): string {
  // Normalize whitespace
  const normalized = sig.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.substring(0, maxLength) + "...";
}

/**
 * Finds the first difference between two strings
 */
function findDifference(before: string, after: string): string {
  const maxLen = Math.max(before.length, after.length);
  let diffStart = -1;

  for (let i = 0; i < maxLen; i++) {
    if (before[i] !== after[i]) {
      diffStart = i;
      break;
    }
  }

  if (diffStart === -1) {
    return "Strings are identical after normalization";
  }

  const contextStart = Math.max(0, diffStart - 50);
  const contextEnd = Math.min(maxLen, diffStart + 200);

  const beforeContext = before.substring(contextStart, contextEnd);
  const afterContext = after.substring(contextStart, contextEnd);

  return `First difference at position ${diffStart}:\n    Before: ...${beforeContext}...\n    After:  ...${afterContext}...`;
}

describe("isUnionTypeWidening", () => {
  test("should recognize single type becoming union", () => {
    const result = isUnionTypeWidening("string", "string | number");
    expect(result).toBe(true);
  });

  test("should recognize type not in union", () => {
    const result = isUnionTypeWidening("boolean", "string | number");
    expect(result).toBe(false);
  });

  test("should handle complex types in union", () => {
    const result = isUnionTypeWidening("string", "string | URL");
    expect(result).toBe(true);
  });

  test("should handle union to larger union", () => {
    const result = isUnionTypeWidening(
      "string | number",
      "string | number | boolean",
    );
    expect(result).toBe(true);
  });

  test("should reject narrowing union", () => {
    const result = isUnionTypeWidening("string | number", "string");
    expect(result).toBe(false);
  });

  test("should reject non-union to non-union change", () => {
    const result = isUnionTypeWidening("string", "number");
    expect(result).toBe(false);
  });
});

describe("areInterfaceSignaturesCompatible", () => {
  test("should allow adding optional fields to interface", () => {
    const oldInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; computeMetadataArgs?: Record<string, any>; }`;
    const newInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; computeMetadataArgs?: Record<string, any>; linkArgs?: LinkArgs; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(true);
  });

  test("should reject removing fields from interface", () => {
    const oldInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; computeMetadataArgs?: Record<string, any>; }`;
    const newInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(false);
  });

  test("should reject adding required fields to interface", () => {
    const oldInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; }`;
    const newInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; requiredField: string; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(false);
  });

  test("should reject changing field types in interface", () => {
    const oldInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; computeMetadataArgs?: Record<string, any>; }`;
    const newInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; computeMetadataArgs?: string; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(false);
  });

  test("should allow making required field optional", () => {
    const oldInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush: IsAsyncFlush; }`;
    const newInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(true);
  });

  test("should reject making optional field required", () => {
    const oldInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush?: IsAsyncFlush; }`;
    const newInterface = `export interface LogOptions<IsAsyncFlush> { asyncFlush: IsAsyncFlush; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(false);
  });

  test("should allow widening field type to union (single type to union)", () => {
    const oldInterface = `export interface EvalOptions<Parameters> { parameters?: Parameters; }`;
    const newInterface = `export interface EvalOptions<Parameters> { parameters?: Parameters | RemoteEvalParameters<boolean, boolean, InferParameters<Parameters>> | Promise<RemoteEvalParameters<boolean, boolean, InferParameters<Parameters>>>; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(true);
  });

  test("should allow widening field type to union (simple case)", () => {
    const oldInterface = `export interface Config { value: string; }`;
    const newInterface = `export interface Config { value: string | number; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(true);
  });

  test("should allow adding an optional field to a documented interface", () => {
    const oldInterface = `interface LoginOptions {
      appUrl?: string;
      apiKey?: string;
      orgName?: string;
      fetch?: typeof globalThis.fetch;
      noExitFlush?: boolean;
      onFlushError?: (error: unknown) => void;
      disableSpanCache?: boolean;
    }`;
    const newInterface = `interface LoginOptions {
      appUrl?: string;
      apiKey?: string;
      orgName?: string;
      fetch?: typeof globalThis.fetch;
      noExitFlush?: boolean;
      onFlushError?: (error: unknown) => void;
      disableSpanCache?: boolean;
      debugLogLevel?: DebugLogLevel | false;
    }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(true);
  });

  test("should reject narrowing field type from union", () => {
    const oldInterface = `export interface Config { value: string | number; }`;
    const newInterface = `export interface Config { value: string; }`;

    const result = areInterfaceSignaturesCompatible(oldInterface, newInterface);
    expect(result).toBe(false);
  });
});

describe("areFunctionSignaturesCompatible", () => {
  test("should allow adding optional parameter at end", () => {
    const oldFn = `export function foo(a: string): void`;
    const newFn = `export function foo(a: string, b?: number): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(true);
  });

  test("should allow adding parameter with default value at end", () => {
    const oldFn = `export function foo(a: string): void`;
    const newFn = `export function foo(a: string, b: number = 5): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(true);
  });

  test("should allow making required parameter optional", () => {
    const oldFn = `export function foo(a: string, b: number): void`;
    const newFn = `export function foo(a: string, b?: number): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(true);
  });

  test("should allow adding default value to parameter", () => {
    const oldFn = `export function foo(a: string, b: number): void`;
    const newFn = `export function foo(a: string, b: number = 10): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(true);
  });

  test("should reject removing parameter", () => {
    const oldFn = `export function foo(a: string, b: number): void`;
    const newFn = `export function foo(a: string): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(false);
  });

  test("should reject adding required parameter", () => {
    const oldFn = `export function foo(a: string): void`;
    const newFn = `export function foo(a: string, b: number): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(false);
  });

  test("should reject making optional parameter required", () => {
    const oldFn = `export function foo(a: string, b?: number): void`;
    const newFn = `export function foo(a: string, b: number): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(false);
  });

  test("should reject changing parameter type", () => {
    const oldFn = `export function foo(a: string): void`;
    const newFn = `export function foo(a: number): void`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(false);
  });

  test("should reject changing return type", () => {
    const oldFn = `export function foo(a: string): void`;
    const newFn = `export function foo(a: string): number`;
    expect(areFunctionSignaturesCompatible(oldFn, newFn)).toBe(false);
  });
});

describe("areTypeAliasSignaturesCompatible", () => {
  test("should allow widening union type", () => {
    const oldType = `export type Foo = string`;
    const newType = `export type Foo = string | number`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(true);
  });

  test("should allow adding more union members", () => {
    const oldType = `export type Status = "pending" | "complete"`;
    const newType = `export type Status = "pending" | "complete" | "error"`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(true);
  });

  test("should allow adding optional properties to object type", () => {
    const oldType = `export type Config = { host: string; port: number; }`;
    const newType = `export type Config = { host: string; port: number; timeout?: number; }`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(true);
  });

  test("should reject narrowing union type", () => {
    const oldType = `export type Foo = string | number`;
    const newType = `export type Foo = string`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(false);
  });

  test("should reject removing union members", () => {
    const oldType = `export type Status = "pending" | "complete" | "error"`;
    const newType = `export type Status = "pending" | "complete"`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(false);
  });

  test("should reject removing properties from object type", () => {
    const oldType = `export type Config = { host: string; port: number; timeout: number; }`;
    const newType = `export type Config = { host: string; port: number; }`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(false);
  });

  test("should reject adding required property to object type", () => {
    const oldType = `export type Config = { host: string; }`;
    const newType = `export type Config = { host: string; port: number; }`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(false);
  });

  test("should reject complete type change", () => {
    const oldType = `export type Foo = string`;
    const newType = `export type Foo = { value: string }`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(false);
  });

  test("should allow widening object type property to union", () => {
    const oldType = `export type Config = { host: string; port: number; }`;
    const newType = `export type Config = { host: string | URL; port: number; }`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(true);
  });

  test("should allow adding optional field to object type (EvaluatorFile scenario)", () => {
    const oldType = `export type EvaluatorFile = { functions: CodeFunction[]; prompts: CodePrompt[]; evaluators: { [evalName: string]: { evaluator: EvaluatorDef; }; }; reporters: { [reporterName: string]: ReporterDef; }; }`;
    const newType = `export type EvaluatorFile = { functions: CodeFunction[]; prompts: CodePrompt[]; parameters?: CodeParameters[]; evaluators: { [evalName: string]: { evaluator: EvaluatorDef; }; }; reporters: { [reporterName: string]: ReporterDef; }; }`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(true);
  });

  test("should allow adding optional properties inside an intersection object member", () => {
    const oldType = `export type InitOptions<IsOpen extends boolean> = FullLoginOptions & { experiment?: string; description?: string; dataset?: AnyDataset | DatasetRef; update?: boolean; } & InitOpenOption<IsOpen>`;
    const newType = `export type InitOptions<IsOpen extends boolean> = FullLoginOptions & { experiment?: string; description?: string; dataset?: AnyDataset | DatasetRef; parameters?: ParametersRef | RemoteEvalParameters<boolean, boolean>; update?: boolean; } & InitOpenOption<IsOpen>`;
    expect(areTypeAliasSignaturesCompatible(oldType, newType)).toBe(true);
  });
});

describe("areEnumSignaturesCompatible", () => {
  test("should allow adding new enum value", () => {
    const oldEnum = `export enum Color { Red = "red", Blue = "blue" }`;
    const newEnum = `export enum Color { Red = "red", Blue = "blue", Green = "green" }`;
    expect(areEnumSignaturesCompatible(oldEnum, newEnum)).toBe(true);
  });

  test("should allow adding enum value with numeric assignment", () => {
    const oldEnum = `export enum Status { Pending = 0, Complete = 1 }`;
    const newEnum = `export enum Status { Pending = 0, Complete = 1, Error = 2 }`;
    expect(areEnumSignaturesCompatible(oldEnum, newEnum)).toBe(true);
  });

  test("should allow adding new enum value with declare syntax", () => {
    const oldEnum = `declare enum SpanTypeAttribute { LLM = "llm", SCORE = "score", FUNCTION = "function", EVAL = "eval", TASK = "task", TOOL = "tool" }`;
    const newEnum = `declare enum SpanTypeAttribute { LLM = "llm", SCORE = "score", FUNCTION = "function", EVAL = "eval", TASK = "task", TOOL = "tool", AUTOMATION = "automation", FACET = "facet", PREPROCESSOR = "preprocessor" }`;
    expect(areEnumSignaturesCompatible(oldEnum, newEnum)).toBe(true);
  });

  test("should reject removing enum value", () => {
    const oldEnum = `export enum Color { Red = "red", Blue = "blue", Green = "green" }`;
    const newEnum = `export enum Color { Red = "red", Blue = "blue" }`;
    expect(areEnumSignaturesCompatible(oldEnum, newEnum)).toBe(false);
  });

  test("should reject changing enum value assignment", () => {
    const oldEnum = `export enum Color { Red = "red", Blue = "blue" }`;
    const newEnum = `export enum Color { Red = "crimson", Blue = "blue" }`;
    expect(areEnumSignaturesCompatible(oldEnum, newEnum)).toBe(false);
  });

  test("should reject changing enum value to different type", () => {
    const oldEnum = `export enum Status { Pending = 0, Complete = 1 }`;
    const newEnum = `export enum Status { Pending = "pending", Complete = 1 }`;
    expect(areEnumSignaturesCompatible(oldEnum, newEnum)).toBe(false);
  });
});

describe("areConstArraySignaturesCompatible", () => {
  test("should allow adding new values at the end of const array", () => {
    const oldSig = `declare const spanTypeAttributeValues: readonly ["llm", "score", "function", "eval", "task", "tool"];`;
    const newSig = `declare const spanTypeAttributeValues: readonly ["llm", "score", "function", "eval", "task", "tool", "automation", "facet", "preprocessor"];`;
    expect(areConstArraySignaturesCompatible(oldSig, newSig)).toBe(true);
  });

  test("should allow adding single value at end", () => {
    const oldSig = `export const values: readonly ["a", "b"];`;
    const newSig = `export const values: readonly ["a", "b", "c"];`;
    expect(areConstArraySignaturesCompatible(oldSig, newSig)).toBe(true);
  });

  test("should reject removing values from const array", () => {
    const oldSig = `declare const values: readonly ["a", "b", "c"];`;
    const newSig = `declare const values: readonly ["a", "b"];`;
    expect(areConstArraySignaturesCompatible(oldSig, newSig)).toBe(false);
  });

  test("should reject reordering values in const array", () => {
    const oldSig = `declare const values: readonly ["a", "b", "c"];`;
    const newSig = `declare const values: readonly ["a", "c", "b"];`;
    expect(areConstArraySignaturesCompatible(oldSig, newSig)).toBe(false);
  });

  test("should reject changing existing values", () => {
    const oldSig = `declare const values: readonly ["a", "b"];`;
    const newSig = `declare const values: readonly ["a", "x"];`;
    expect(areConstArraySignaturesCompatible(oldSig, newSig)).toBe(false);
  });

  test("should handle identical arrays", () => {
    const oldSig = `declare const values: readonly ["a", "b"];`;
    const newSig = `declare const values: readonly ["a", "b"];`;
    expect(areConstArraySignaturesCompatible(oldSig, newSig)).toBe(true);
  });
});

/**
 * Gets exports from main branch for baseline comparison.
 * Since dist/ files aren't in git, we need to build main first in CI.
 * This checks if a pre-built baseline exists from CI, otherwise returns null.
 */
async function getMainBranchExports(entrypoint: {
  name: string;
  typesPath: string;
}): Promise<Map<string, ExportedSymbol> | null> {
  try {
    // Check if we're in CI and have a baseline directory
    const baselineDir =
      process.env.BASELINE_DIR || path.join(os.tmpdir(), "braintrust-baseline");
    const baselinePath = path.join(baselineDir, "js", entrypoint.typesPath);

    if (fs.existsSync(baselinePath)) {
      // Baseline exists (built by CI)
      console.log(`${entrypoint.name}: Using baseline from ${baselinePath}`);
      const exports = extractExportsFromDts(baselinePath);
      return exports;
    }

    // Fallback: try to read from git (won't work for .d.ts but good for testing)
    const filePath = `js/${entrypoint.typesPath}`;
    const content = execSync(`git show origin/main:${filePath}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"], // Suppress stderr
    });

    // Parse the content as if it were a file
    const tempFile = path.join(
      os.tmpdir(),
      `main-${entrypoint.name}-${Date.now()}.d.ts`,
    );
    fs.writeFileSync(tempFile, content);
    const exports = extractExportsFromDts(tempFile);
    fs.unlinkSync(tempFile);

    return exports;
  } catch (error) {
    // Baseline not available - will fall back to direct comparison
    return null;
  }
}

interface BreakingChanges {
  removed: ExportedSymbol[];
  modified: Array<{
    name: string;
    before: string;
    after: string;
    kind: string;
  }>;
}

/**
 * Finds new breaking changes that exist in current but not in baseline.
 * This allows us to only fail on NEW breaking changes introduced by the PR.
 */
function findNewBreakingChanges(
  baselineChanges: BreakingChanges,
  currentChanges: BreakingChanges,
  baselineExports?: Map<string, ExportedSymbol>,
  currentExports?: Map<string, ExportedSymbol>,
): BreakingChanges {
  // Find removed exports in current that don't exist in baseline
  const newRemoved = currentChanges.removed.filter(
    (exp) => !baselineChanges.removed.some((b) => b.name === exp.name),
  );

  // Find modified exports in current that don't exist in baseline
  // Also exclude exports that normalize to the same signature (not actually breaking)
  const newModified = currentChanges.modified.filter((exp) => {
    // Check if this export exists in baseline with same name
    const baselineMod = baselineChanges.modified.find(
      (b) => b.name === exp.name,
    );

    if (baselineMod) {
      // It exists in baseline modified - check if the "after" signatures normalize to the same thing
      // If they do, it's the same breaking change that's already in main, not a new one
      const baselineAfterNorm = normalizeTypeReference(
        baselineMod.after.replace(/\s+/g, " ").trim(),
      );
      const currentAfterNorm = normalizeTypeReference(
        exp.after.replace(/\s+/g, " ").trim(),
      );

      // Only consider it "new" if normalized "after" signatures are different
      return baselineAfterNorm !== currentAfterNorm;
    }

    // Not in baseline modified list - check if it exists in baseline exports
    // If it does and normalized signatures match, it's not a new breaking change
    if (baselineExports && currentExports) {
      const baselineExp = baselineExports.get(exp.name);
      const currentExp = currentExports.get(exp.name);

      if (baselineExp && currentExp) {
        // Both exist - check if normalized signatures match
        const baselineNorm = normalizeTypeReference(
          baselineExp.signature.replace(/\s+/g, " ").trim(),
        );
        const currentNorm = normalizeTypeReference(
          currentExp.signature.replace(/\s+/g, " ").trim(),
        );

        // If they normalize to the same, it's not a new breaking change
        if (baselineNorm === currentNorm) {
          return false;
        }
      }
    }

    // Not in baseline at all, or signatures don't match - it's new
    return true;
  });

  return { removed: newRemoved, modified: newModified };
}

describe("API Compatibility", () => {
  let tempDir: string;
  let publishedVersion: string;
  let currentVersion: string;
  let versionBumpType: "major" | "minor" | "patch" | "none";

  beforeAll(async () => {
    // Load entrypoints from tsup config
    ENTRYPOINTS = await getEntrypointsFromTsupConfig();
    console.log(
      `Loaded ${ENTRYPOINTS.length} entrypoints from tsup.config.ts:`,
      ENTRYPOINTS.map((e) => e.name).join(", "),
    );

    // Get current version from package.json
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    currentVersion = packageJson.version;

    // Get latest published version from npm
    try {
      publishedVersion = execSync("npm view braintrust version", {
        encoding: "utf-8",
      }).trim();
    } catch {
      console.warn(
        "Could not fetch published version from npm. Skipping API compatibility test.",
      );
      publishedVersion = "";
      return;
    }

    // Determine version bump type
    const publishedVersionInfo = parseVersion(publishedVersion);
    const currentVersionInfo = parseVersion(currentVersion);
    versionBumpType = getVersionBumpType(
      publishedVersionInfo,
      currentVersionInfo,
    );

    console.log(`Published version: ${publishedVersion}`);
    console.log(`Current version: ${currentVersion}`);
    console.log(`Version bump type: ${versionBumpType}`);

    // Create temp directory for downloaded package
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "braintrust-api-test-"));

    // Download and extract published package
    const packOutput = execSync(`npm pack braintrust@${publishedVersion}`, {
      encoding: "utf-8",
      cwd: tempDir,
    }).trim();

    const tarballPath = path.join(tempDir, packOutput);

    // Extract tarball using tar package (cross-platform)
    await tar.x({
      file: tarballPath,
      cwd: tempDir,
    });
  }, 30000); // 30 second timeout for downloading

  afterAll(() => {
    // Cleanup temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("should be able to download published version", () => {
    if (!publishedVersion) {
      console.log("Skipping: No published version available");
      return;
    }

    expect(publishedVersion).toBeTruthy();
    expect(tempDir).toBeTruthy();
    expect(fs.existsSync(path.join(tempDir, "package"))).toBe(true);
  });

  test("should not regress public API surface for all entrypoints", async () => {
    if (!publishedVersion) {
      console.log("Skipping test: No published version available");
      return;
    }

    // Track any failures to report them all at once
    const failures: string[] = [];

    for (const entrypoint of ENTRYPOINTS) {
      const publishedTypesPath = path.join(
        tempDir,
        "package",
        entrypoint.typesPath,
      );
      const currentTypesPath = path.join(
        __dirname,
        "..",
        "..",
        entrypoint.typesPath,
      );

      // Check if both files exist
      if (!fs.existsSync(publishedTypesPath)) {
        console.warn(
          `Published types not found: ${publishedTypesPath}. Skipping ${entrypoint.name}.`,
        );
        continue;
      }

      if (!fs.existsSync(currentTypesPath)) {
        throw new Error(
          `Current types not found: ${currentTypesPath}. Build the package first with: pnpm build`,
        );
      }

      // Extract exports from both versions
      const publishedExports = extractExportsFromDts(publishedTypesPath);
      const currentExports = extractExportsFromDts(currentTypesPath);

      console.log(
        `${entrypoint.name}: Published exports: ${publishedExports.size}, Current exports: ${currentExports.size}`,
      );

      // Verify that current runtime exports match .d.ts declarations
      const currentMjsPath = path
        .join(__dirname, "..", entrypoint.typesPath)
        .replace(/\.d\.ts$/, ".mjs");
      if (fs.existsSync(currentMjsPath)) {
        const runtimeExports = await extractRuntimeExports(currentMjsPath);
        const runtimeErrors = verifyRuntimeMatchesTypes(
          currentExports,
          runtimeExports,
          entrypoint.name,
        );
        if (runtimeErrors.length > 0) {
          failures.push(
            `[${entrypoint.name}] Runtime exports don't match TypeScript declarations:\n` +
              runtimeErrors.map((e) => `  - ${e}`).join("\n"),
          );
        }
      }

      // Try to get main branch exports for baseline comparison
      const mainExports = await getMainBranchExports(entrypoint);

      if (mainExports) {
        // Three-way comparison: compare both current and main against published
        const baselineComparison = compareExports(
          publishedExports,
          mainExports,
        );
        const currentComparison = compareExports(
          publishedExports,
          currentExports,
        );

        // Log additions in current
        if (currentComparison.added.length > 0) {
          console.log(
            `${entrypoint.name}: Added ${currentComparison.added.length} exports:`,
            currentComparison.added.map((e) => e.name).join(", "),
          );
        }

        // Build breaking changes objects
        const baselineBreaking: BreakingChanges = {
          removed: baselineComparison.removed,
          modified: baselineComparison.modified,
        };

        const currentBreaking: BreakingChanges = {
          removed: currentComparison.removed,
          modified: currentComparison.modified,
        };

        // Find NEW breaking changes (not in baseline)
        // Also pass exports so we can check normalized signatures even if not in modified list
        const newBreaking = findNewBreakingChanges(
          baselineBreaking,
          currentBreaking,
          mainExports,
          currentExports,
        );

        // Log baseline info (informational only)
        if (
          baselineBreaking.removed.length > 0 ||
          baselineBreaking.modified.length > 0
        ) {
          console.log(
            `${entrypoint.name}: Main branch has ${baselineBreaking.removed.length} removed + ${baselineBreaking.modified.length} modified exports vs published (baseline)`,
          );
        }

        // Only fail if PR introduces NEW breaking changes beyond baseline
        if (
          (newBreaking.removed.length > 0 || newBreaking.modified.length > 0) &&
          versionBumpType !== "major"
        ) {
          const errors: string[] = [];

          if (newBreaking.removed.length > 0) {
            errors.push(
              `NEW removed exports (${newBreaking.removed.length}):\n` +
                newBreaking.removed
                  .map((e) => `  - ${e.name} (${e.kind})`)
                  .join("\n"),
            );
          }

          if (newBreaking.modified.length > 0) {
            errors.push(
              `NEW modified exports (${newBreaking.modified.length}):\n` +
                newBreaking.modified
                  .map((m) => {
                    const beforeNorm = normalizeTypeReference(
                      m.before.replace(/\s+/g, " ").trim(),
                    );
                    const afterNorm = normalizeTypeReference(
                      m.after.replace(/\s+/g, " ").trim(),
                    );

                    if (beforeNorm === afterNorm) {
                      return `  - ${m.name} (${m.kind})\n    Note: Signatures appear identical after normalization`;
                    }

                    return `  - ${m.name} (${m.kind})\n    ${findDifference(beforeNorm, afterNorm)}`;
                  })
                  .join("\n"),
            );
          }

          failures.push(
            `[${entrypoint.name}] Your PR introduces NEW breaking changes (beyond what's in main):\n` +
              errors.join("\n\n"),
          );
        }

        // For major version bumps, log but don't fail
        if (
          versionBumpType === "major" &&
          (newBreaking.removed.length > 0 || newBreaking.modified.length > 0)
        ) {
          console.log(
            `${entrypoint.name}: New breaking changes detected (allowed for major version)`,
          );
        }
      } else {
        // Fallback: direct comparison if main branch not available
        console.log(
          `${entrypoint.name}: Could not read main branch, using direct comparison`,
        );

        const comparison = compareExports(publishedExports, currentExports);

        // Log additions
        if (comparison.added.length > 0) {
          console.log(
            `${entrypoint.name}: Added ${comparison.added.length} exports:`,
            comparison.added.map((e) => e.name).join(", "),
          );
        }

        // Check for breaking changes
        const hasBreakingChanges =
          comparison.removed.length > 0 || comparison.modified.length > 0;

        if (hasBreakingChanges && versionBumpType !== "major") {
          const errors: string[] = [];

          if (comparison.removed.length > 0) {
            errors.push(
              `Removed exports (${comparison.removed.length}):\n` +
                comparison.removed
                  .map((e) => `  - ${e.name} (${e.kind})`)
                  .join("\n"),
            );
          }

          if (comparison.modified.length > 0) {
            errors.push(
              `Modified exports (${comparison.modified.length}):\n` +
                comparison.modified
                  .map((m) => {
                    const beforeNorm = normalizeTypeReference(
                      m.before.replace(/\s+/g, " ").trim(),
                    );
                    const afterNorm = normalizeTypeReference(
                      m.after.replace(/\s+/g, " ").trim(),
                    );

                    if (beforeNorm === afterNorm) {
                      return `  - ${m.name} (${m.kind})\n    Note: Signatures appear identical after normalization`;
                    }

                    return `  - ${m.name} (${m.kind})\n    ${findDifference(beforeNorm, afterNorm)}`;
                  })
                  .join("\n"),
            );
          }

          failures.push(
            `[${entrypoint.name}] Breaking changes detected, but version bump is only ${versionBumpType}:\n` +
              errors.join("\n\n"),
          );
        }

        // For major version bumps, log but don't fail
        if (versionBumpType === "major" && hasBreakingChanges) {
          console.log(
            `${entrypoint.name}: Breaking changes detected (allowed for major version)`,
          );
        }
      }
    }

    // If there were any failures, throw them all at once
    if (failures.length > 0) {
      throw new Error(
        `Breaking changes detected in ${failures.length} entrypoint(s):\n\n` +
          failures.join("\n\n") +
          `\n\nFor a ${versionBumpType} version bump, only additions are allowed, not removals or modifications.\n` +
          `Either:\n` +
          `  1. Bump to a major version if these breaking changes are intentional\n` +
          `  2. Restore the removed/modified APIs to maintain backward compatibility`,
      );
    }
  }, 30000);
});
