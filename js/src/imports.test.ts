import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("CLI import restrictions", () => {
  it("should not import from cli directory in non-cli code", () => {
    const srcDir = path.join(__dirname);
    const violations: string[] = [];

    function walkDirectory(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(srcDir, fullPath);

        // Skip CLI directory and test files
        if (relativePath.startsWith("cli/") || relativePath === "cli") {
          continue;
        }

        if (entry.isDirectory() && entry.name === "node_modules") {
          continue;
        }

        if (entry.isDirectory()) {
          walkDirectory(fullPath);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.endsWith(".d.tsx")
        ) {
          checkFileForCliImports(fullPath, relativePath);
        }
      }
    }

    function checkFileForCliImports(filePath: string, relativePath: string) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        // Check for import statements that reference CLI
        const importMatch =
          line.match(/from\s+["']([^"']+)["']/) ||
          line.match(/import\s*\(\s*["']([^"']+)["']\s*\)/);

        if (importMatch) {
          const importPath = importMatch[1];

          // Check if the import path references the CLI directory
          // Only match actual /cli/ directory paths, not package names containing "cli"
          // (e.g., @temporalio/client should not match)
          if (
            importPath.includes("/cli/") ||
            importPath === "./cli" ||
            importPath === "../cli" ||
            importPath.endsWith("/cli") ||
            importPath.match(/^\.\.\/.*\/cli$/) ||
            importPath.match(/^\.\.\/.*\/cli\//)
          ) {
            violations.push(
              `${relativePath}:${index + 1} - Illegal import from CLI: "${importPath}"`,
            );
          }
        }
      });
    }

    walkDirectory(srcDir);

    if (violations.length > 0) {
      const message = [
        "Found illegal imports from CLI directory in SDK code:",
        "",
        ...violations,
        "",
        "SDK code (src/**) must not import from CLI code (src/cli/**).",
        "CLI code can import from SDK code, but not vice versa.",
      ].join("\n");

      expect.fail(message);
    }
  });

  it("should not allow eslint-disable comments for no-restricted-imports", () => {
    const srcDir = path.join(__dirname);
    const violations: string[] = [];

    function walkDirectory(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(srcDir, fullPath);

        // Skip CLI directory and test files
        if (relativePath.startsWith("cli/") || relativePath === "cli") {
          continue;
        }

        if (entry.isDirectory() && entry.name === "node_modules") {
          continue;
        }

        if (entry.isDirectory()) {
          walkDirectory(fullPath);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.endsWith(".d.tsx") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".test.tsx")
        ) {
          checkFileForDisableComments(fullPath, relativePath);
        }
      }
    }

    function checkFileForDisableComments(
      filePath: string,
      relativePath: string,
    ) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        // Check for various forms of eslint-disable comments
        const disablePatterns = [
          /eslint-disable.*no-restricted-imports/i,
          /eslint-disable-next-line.*no-restricted-imports/i,
          /eslint-disable-line.*no-restricted-imports/i,
        ];

        for (const pattern of disablePatterns) {
          if (pattern.test(line)) {
            violations.push(
              `${relativePath}:${index + 1} - Attempted to disable no-restricted-imports rule: "${line.trim()}"`,
            );
          }
        }
      });
    }

    walkDirectory(srcDir);

    if (violations.length > 0) {
      const message = [
        "Found attempts to disable the no-restricted-imports rule in SDK code:",
        "",
        ...violations,
        "",
        "Disabling the no-restricted-imports rule is not allowed.",
        "This rule prevents SDK code from importing CLI code and cannot be bypassed.",
        "If you believe you have a legitimate need for this import, please discuss with the team.",
      ].join("\n");

      expect.fail(message);
    }
  });

  it("should not allow require() or dynamic import() statements", () => {
    const srcDir = path.join(__dirname);
    const violations: string[] = [];

    function walkDirectory(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(srcDir, fullPath);

        // Skip the cli directory - CLI code is allowed to use require() and dynamic imports
        if (entry.isDirectory() && entry.name === "cli") {
          continue;
        }

        // Skip node_modules directories (test fixture deps, not SDK source)
        if (entry.isDirectory() && entry.name === "node_modules") {
          continue;
        }

        if (entry.isDirectory()) {
          walkDirectory(fullPath);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.endsWith(".d.tsx") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".test.tsx")
        ) {
          checkFileForDynamicImports(fullPath, relativePath);
        }
      }
    }

    function checkFileForDynamicImports(
      filePath: string,
      relativePath: string,
    ) {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        // Check for require() calls
        if (/\brequire\s*\(/.test(line)) {
          violations.push(
            `${relativePath}:${index + 1} - Found require() statement: "${line.trim()}"`,
          );
        }

        // Check for dynamic import() statements
        // Match import(...) but not static import statements
        // Exception: allow dynamic import in anthropic-plugin for APIPromise patching
        if (
          /\bimport\s*\(/.test(line) &&
          !/^import\s+/.test(line.trim()) &&
          !relativePath.includes("instrumentation/plugins/anthropic-plugin.ts")
        ) {
          violations.push(
            `${relativePath}:${index + 1} - Found dynamic import() statement: "${line.trim()}"`,
          );
        }
      });
    }

    walkDirectory(srcDir);

    if (violations.length > 0) {
      const message = [
        "Found require() or dynamic import() statements in SDK code:",
        "",
        ...violations,
        "",
        "require() and dynamic import() are not allowed.",
        "Use static ES module imports instead.",
      ].join("\n");

      expect.fail(message);
    }
  });
});
