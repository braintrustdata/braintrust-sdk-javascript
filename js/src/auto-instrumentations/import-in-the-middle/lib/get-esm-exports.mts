"use strict";

import { Parser } from "acorn";
import { importAttributesOrAssertions } from "acorn-import-attributes";
import type {
  ArrayPattern,
  AssignmentPattern,
  AssignmentProperty,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  ExportSpecifier,
  Identifier,
  Literal,
  ModuleDeclaration,
  ObjectPattern,
  Pattern,
  Program,
  RestElement,
  Statement,
  VariableDeclarator,
} from "acorn";

const acornOpts = {
  ecmaVersion: "latest" as const,
  sourceType: "module" as const,
};

const parser = Parser.extend(importAttributesOrAssertions);
type ExportDeclaration =
  | ExportAllDeclaration
  | ExportDefaultDeclaration
  | ExportNamedDeclaration;

function warn(txt: string): void {
  process.emitWarning(txt, "get-esm-exports");
}

function isExportDeclaration(
  node: Statement | ModuleDeclaration,
): node is ExportDeclaration {
  return (
    node.type === "ExportAllDeclaration" ||
    node.type === "ExportDefaultDeclaration" ||
    node.type === "ExportNamedDeclaration"
  );
}

function getLiteralString(node: Literal): string | undefined {
  return typeof node.value === "string" ? node.value : undefined;
}

function getExportedName(node: Identifier | Literal): string | undefined {
  return node.type === "Identifier" ? node.name : getLiteralString(node);
}

/**
 * Utilizes an AST parser to interpret ESM source code and build a list of
 * exported identifiers. In the baseline case, the list of identifiers will be
 * the simple identifier names as written in the source code of the module.
 * However, there is a special case:
 *
 * When an `export * from './foo.js'` line is encountered it is rewritten
 * as `* from ./foo.js`. This allows the interpreting code to recognize a
 * transitive export and recursively parse the indicated module. The returned
 * identifier list will have "* from ./foo.js" as an item.
 *
 * @param {object} params
 * @param {string} params.moduleSource The source code of the module to parse
 * and interpret.
 *
 * @returns {Set<string>} The identifiers exported by the module along with any
 * custom directives.
 */
export default function getEsmExports(moduleSource: string): Set<string> {
  const exportedNames = new Set<string>();
  const tree = parser.parse(moduleSource, acornOpts) as Program;
  for (const node of tree.body) {
    if (!isExportDeclaration(node)) continue;
    switch (node.type) {
      case "ExportNamedDeclaration":
        if (node.declaration) {
          parseDeclaration(node, exportedNames);
        } else {
          parseSpecifiers(node, exportedNames);
        }
        break;

      case "ExportDefaultDeclaration": {
        exportedNames.add("default");
        break;
      }

      case "ExportAllDeclaration":
        if (node.exported) {
          const exportedName = getExportedName(node.exported);
          if (exportedName) {
            exportedNames.add(exportedName);
          } else {
            warn("unrecognized export-all name type: " + node.exported.type);
          }
        } else {
          const source = getLiteralString(node.source);
          if (source) {
            exportedNames.add(`* from ${source}`);
          } else {
            warn("unrecognized export-all source type: " + node.source.type);
          }
        }
        break;
    }
  }
  return exportedNames;
}

function parseDeclaration(
  node: ExportNamedDeclaration,
  exportedNames: Set<string>,
): void {
  const { declaration } = node;
  if (!declaration) return;

  switch (declaration.type) {
    case "FunctionDeclaration":
      exportedNames.add(declaration.id.name);
      break;
    case "VariableDeclaration":
      for (const varDecl of declaration.declarations) {
        parseVariableDeclaration(varDecl, exportedNames);
      }
      break;
    case "ClassDeclaration":
      exportedNames.add(declaration.id.name);
      break;
  }
}

function parseVariableDeclaration(
  node: VariableDeclarator,
  exportedNames: Set<string>,
): void {
  parsePattern(node.id, exportedNames);
}

function parsePattern(node: Pattern, exportedNames: Set<string>): void {
  switch (node.type) {
    case "Identifier":
      exportedNames.add(node.name);
      break;
    case "ObjectPattern":
      parseObjectPattern(node, exportedNames);
      break;
    case "ArrayPattern":
      parseArrayPattern(node, exportedNames);
      break;
    case "RestElement":
      parseRestElement(node, exportedNames);
      break;
    case "AssignmentPattern":
      parseAssignmentPattern(node, exportedNames);
      break;
    default:
      warn("unknown variable declaration type: " + node.type);
  }
}

function parseObjectPattern(
  node: ObjectPattern,
  exportedNames: Set<string>,
): void {
  for (const property of node.properties) {
    if (property.type === "RestElement") {
      parseRestElement(property, exportedNames);
    } else {
      parseAssignmentProperty(property, exportedNames);
    }
  }
}

function parseAssignmentProperty(
  node: AssignmentProperty,
  exportedNames: Set<string>,
): void {
  parsePattern(node.value, exportedNames);
}

function parseArrayPattern(
  node: ArrayPattern,
  exportedNames: Set<string>,
): void {
  for (const element of node.elements) {
    if (element) {
      parsePattern(element, exportedNames);
    }
  }
}

function parseRestElement(node: RestElement, exportedNames: Set<string>): void {
  parsePattern(node.argument, exportedNames);
}

function parseAssignmentPattern(
  node: AssignmentPattern,
  exportedNames: Set<string>,
): void {
  parsePattern(node.left, exportedNames);
}

function parseSpecifiers(
  node: ExportNamedDeclaration,
  exportedNames: Set<string>,
): void {
  for (const specifier of node.specifiers) {
    parseSpecifier(specifier, exportedNames);
  }
}

function parseSpecifier(
  specifier: ExportSpecifier,
  exportedNames: Set<string>,
): void {
  const exportedName = getExportedName(specifier.exported);
  if (exportedName) {
    exportedNames.add(exportedName);
  } else {
    warn("unrecognized specifier type: " + specifier.exported.type);
  }
}
