import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Import restrictions", () => {
  it("should not allow eslint-disable comments for no-restricted-imports", () => {
    const srcDir = path.join(__dirname);
    const violations: string[] = [];

    function walkDirectory(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(srcDir, fullPath);

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
        "This rule protects SDK module boundaries and cannot be bypassed.",
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

      // Exception: the Mastra observability patch *generates* CJS source code
      // (a string of JavaScript that is appended to @mastra/core's
      // dist/mastra/index.cjs). That source legitimately contains
      // `require(...)` because it runs inside a CommonJS module's evaluation
      // — it isn't a require() call from our SDK code itself. Normalize the
      // separator so the exemption matches on Windows (`\\`) too.
      const isMastraPatchGenerator = relativePath
        .replaceAll(path.sep, "/")
        .includes("auto-instrumentations/loader/mastra-observability-patch.ts");

      lines.forEach((line, index) => {
        // Check for require() calls
        if (/\brequire\s*\(/.test(line) && !isMastraPatchGenerator) {
          violations.push(
            `${relativePath}:${index + 1} - Found require() statement: "${line.trim()}"`,
          );
        }

        // Check for dynamic import() statements
        // Match import(...) but not static import statements
        // Exception: allow dynamic import in anthropic-instrumentation for APIPromise patching
        if (
          /\bimport\s*\(/.test(line) &&
          !/^import\s+/.test(line.trim()) &&
          !relativePath.includes(
            "instrumentation/providers/anthropic-instrumentation.ts",
          )
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
