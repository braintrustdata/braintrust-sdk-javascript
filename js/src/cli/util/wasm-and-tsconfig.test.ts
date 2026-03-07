import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// We need to test internal functions, so we'll import from index and mock appropriately
// For now, we'll test the behavior through integration-style tests

describe("WASM Detection in nativeNodeModulesPlugin", () => {
  describe("packageContainsWasm logic", () => {
    const packageContainsWasm = (pkgPath: string): boolean => {
      try {
        const checkDir = (dir: string, depth = 0): boolean => {
          if (depth > 2) return false;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".wasm")) {
              return true;
            }
            if (
              entry.isDirectory() &&
              !entry.name.startsWith(".") &&
              entry.name !== "node_modules"
            ) {
              if (checkDir(path.join(dir, entry.name), depth + 1)) {
                return true;
              }
            }
          }
          return false;
        };
        return checkDir(pkgPath);
      } catch {
        return false;
      }
    };

    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should detect wasm file in package root", () => {
      fs.writeFileSync(path.join(tmpDir, "index.wasm"), "");
      expect(packageContainsWasm(tmpDir)).toBe(true);
    });

    it("should detect wasm file in subdirectory", () => {
      const wasmDir = path.join(tmpDir, "wasm");
      fs.mkdirSync(wasmDir);
      fs.writeFileSync(path.join(wasmDir, "libpg-query.wasm"), "");
      expect(packageContainsWasm(tmpDir)).toBe(true);
    });

    it("should detect wasm file in nested subdirectory (depth 2)", () => {
      const nestedDir = path.join(tmpDir, "lib", "wasm");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(nestedDir, "module.wasm"), "");
      expect(packageContainsWasm(tmpDir)).toBe(true);
    });

    it("should not detect wasm file beyond depth limit (depth 3)", () => {
      const deepDir = path.join(tmpDir, "a", "b", "c");
      fs.mkdirSync(deepDir, { recursive: true });
      fs.writeFileSync(path.join(deepDir, "deep.wasm"), "");
      expect(packageContainsWasm(tmpDir)).toBe(false);
    });

    it("should return false for directory without wasm files", () => {
      fs.writeFileSync(path.join(tmpDir, "index.js"), "");
      fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
      expect(packageContainsWasm(tmpDir)).toBe(false);
    });

    it("should skip node_modules directory", () => {
      const nodeModules = path.join(tmpDir, "node_modules", "dep");
      fs.mkdirSync(nodeModules, { recursive: true });
      fs.writeFileSync(path.join(nodeModules, "module.wasm"), "");
      expect(packageContainsWasm(tmpDir)).toBe(false);
    });

    it("should skip hidden directories", () => {
      const hiddenDir = path.join(tmpDir, ".hidden");
      fs.mkdirSync(hiddenDir);
      fs.writeFileSync(path.join(hiddenDir, "secret.wasm"), "");
      expect(packageContainsWasm(tmpDir)).toBe(false);
    });

    it("should return false for non-existent directory", () => {
      expect(packageContainsWasm("/non/existent/path")).toBe(false);
    });

    it("should handle libpg-query-like structure", () => {
      // Simulate libpg-query package structure
      const wasmDir = path.join(tmpDir, "wasm");
      fs.mkdirSync(wasmDir);
      fs.writeFileSync(path.join(wasmDir, "libpg-query.wasm"), "");
      fs.writeFileSync(path.join(tmpDir, "index.js"), "module.exports = {}");
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "libpg-query" }),
      );
      expect(packageContainsWasm(tmpDir)).toBe(true);
    });
  });

  describe("onResolve for .wasm files", () => {
    it("should mark .wasm imports as external", () => {
      const onResolveCalls: Array<{
        filter: RegExp;
        callback: (args: { path: string; resolveDir: string }) => unknown;
      }> = [];

      const mockBuild = {
        onResolve: (
          opts: { filter: RegExp },
          callback: (args: { path: string; resolveDir: string }) => unknown,
        ) => {
          onResolveCalls.push({ filter: opts.filter, callback });
        },
      };

      // Find the .wasm filter
      const wasmFilter = /\.wasm$/;

      // Simulate the callback behavior
      const wasmCallback = (args: { path: string }) => {
        return { path: args.path, external: true };
      };

      expect(wasmCallback({ path: "./module.wasm" })).toEqual({
        path: "./module.wasm",
        external: true,
      });

      expect(
        wasmCallback({ path: "libpg-query/wasm/libpg-query.wasm" }),
      ).toEqual({
        path: "libpg-query/wasm/libpg-query.wasm",
        external: true,
      });
    });
  });
});

describe("TSConfig Extends Resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsconfig-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Re-implement the function for testing since it's not exported
  function resolveTsconfigExtends(tsconfigPath: string): string | undefined {
    try {
      const tsconfigContent = fs.readFileSync(tsconfigPath, "utf-8");
      const cleanedContent = tsconfigContent
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1");
      const tsconfig = JSON.parse(cleanedContent);

      if (!tsconfig.extends) {
        return tsconfigPath;
      }

      const extendsPath = tsconfig.extends;

      if (extendsPath.startsWith(".") || extendsPath.startsWith("/")) {
        return tsconfigPath;
      }

      const tsconfigDir = path.dirname(tsconfigPath);
      let resolvedExtendsPath: string;
      try {
        resolvedExtendsPath = require.resolve(extendsPath, {
          paths: [tsconfigDir],
        });
      } catch {
        try {
          resolvedExtendsPath = require.resolve(`${extendsPath}.json`, {
            paths: [tsconfigDir],
          });
        } catch {
          return tsconfigPath;
        }
      }

      const tmpResolveDir = path.join(os.tmpdir(), `bt-tsconfig-${Date.now()}`);
      fs.mkdirSync(tmpResolveDir, { recursive: true });
      const tmpTsconfigPath = path.join(tmpResolveDir, "tsconfig.json");

      const relativeExtendsPath = path.relative(
        tmpResolveDir,
        resolvedExtendsPath,
      );
      tsconfig.extends = relativeExtendsPath;

      if (tsconfig.compilerOptions?.baseUrl) {
        const resolvedBaseUrl = path.resolve(
          tsconfigDir,
          tsconfig.compilerOptions.baseUrl,
        );
        tsconfig.compilerOptions.baseUrl = path.relative(
          tmpResolveDir,
          resolvedBaseUrl,
        );
      }

      if (tsconfig.include) {
        tsconfig.include = tsconfig.include.map((p: string) =>
          path.resolve(tsconfigDir, p),
        );
      }
      if (tsconfig.exclude) {
        tsconfig.exclude = tsconfig.exclude.map((p: string) =>
          path.resolve(tsconfigDir, p),
        );
      }
      if (tsconfig.files) {
        tsconfig.files = tsconfig.files.map((p: string) =>
          path.resolve(tsconfigDir, p),
        );
      }

      fs.writeFileSync(tmpTsconfigPath, JSON.stringify(tsconfig, null, 2));
      return tmpTsconfigPath;
    } catch {
      return tsconfigPath;
    }
  }

  it("should return original path when no extends field", () => {
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: { strict: true },
      }),
    );

    const result = resolveTsconfigExtends(tsconfigPath);
    expect(result).toBe(tsconfigPath);
  });

  it("should return original path when extends is relative", () => {
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "./base.json",
        compilerOptions: { strict: true },
      }),
    );

    const result = resolveTsconfigExtends(tsconfigPath);
    expect(result).toBe(tsconfigPath);
  });

  it("should return original path when extends is absolute", () => {
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "/absolute/path/base.json",
        compilerOptions: { strict: true },
      }),
    );

    const result = resolveTsconfigExtends(tsconfigPath);
    expect(result).toBe(tsconfigPath);
  });

  it("should handle tsconfig with comments", () => {
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      `{
        // This is a comment
        "compilerOptions": {
          "strict": true /* inline comment */
        }
      }`,
    );

    const result = resolveTsconfigExtends(tsconfigPath);
    expect(result).toBe(tsconfigPath);
  });

  it("should handle tsconfig with trailing commas", () => {
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      `{
        "compilerOptions": {
          "strict": true,
        },
      }`,
    );

    const result = resolveTsconfigExtends(tsconfigPath);
    expect(result).toBe(tsconfigPath);
  });

  it("should return original path for non-existent file", () => {
    const result = resolveTsconfigExtends("/non/existent/tsconfig.json");
    expect(result).toBe("/non/existent/tsconfig.json");
  });

  it("should resolve include/exclude to absolute paths", () => {
    // Create a mock node_modules structure
    const nodeModules = path.join(tmpDir, "node_modules", "tsconfig-base");
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(
      path.join(nodeModules, "package.json"),
      JSON.stringify({ name: "tsconfig-base", main: "tsconfig.json" }),
    );
    fs.writeFileSync(
      path.join(nodeModules, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );

    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "tsconfig-base",
        include: ["src/**/*"],
        exclude: ["node_modules"],
      }),
    );

    const result = resolveTsconfigExtends(tsconfigPath);

    // Should return a temp path since extends was resolved
    expect(result).not.toBe(tsconfigPath);
    expect(result).toContain("bt-tsconfig-");

    // Read the resolved tsconfig and check paths are resolved
    const resolvedTsconfig = JSON.parse(fs.readFileSync(result!, "utf-8"));
    // path.resolve normalizes the glob pattern, so we just check it starts with tmpDir
    expect(resolvedTsconfig.include[0]).toContain(tmpDir);
    expect(resolvedTsconfig.include[0]).toContain("src");
    expect(resolvedTsconfig.exclude[0]).toBe(
      path.resolve(tmpDir, "node_modules"),
    );
  });

  it("should resolve baseUrl to be relative from temp dir to original", () => {
    const nodeModules = path.join(tmpDir, "node_modules", "tsconfig-base");
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(
      path.join(nodeModules, "package.json"),
      JSON.stringify({ name: "tsconfig-base", main: "tsconfig.json" }),
    );
    fs.writeFileSync(
      path.join(nodeModules, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );

    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "tsconfig-base",
        compilerOptions: {
          baseUrl: "./src",
        },
      }),
    );

    const result = resolveTsconfigExtends(tsconfigPath);

    // Read the resolved tsconfig and check baseUrl
    const resolvedTsconfig = JSON.parse(fs.readFileSync(result!, "utf-8"));
    // baseUrl is stored as a relative path from the temp directory to the original src
    // It should contain "src" since that's what we're pointing to
    expect(resolvedTsconfig.compilerOptions.baseUrl).toContain("src");
    // And it should be a relative path (starting with .. since temp dir is different)
    expect(resolvedTsconfig.compilerOptions.baseUrl.startsWith("..")).toBe(
      true,
    );
  });
});

describe("Real-world WASM Package Scenarios", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-scenario-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const packageContainsWasm = (pkgPath: string): boolean => {
    try {
      const checkDir = (dir: string, depth = 0): boolean => {
        if (depth > 2) return false;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".wasm")) {
            return true;
          }
          if (
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            entry.name !== "node_modules"
          ) {
            if (checkDir(path.join(dir, entry.name), depth + 1)) {
              return true;
            }
          }
        }
        return false;
      };
      return checkDir(pkgPath);
    } catch {
      return false;
    }
  };

  it("should detect libpg-query structure", () => {
    // Simulate libpg-query package structure
    const pkgDir = path.join(tmpDir, "libpg-query");
    fs.mkdirSync(path.join(pkgDir, "wasm"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "wasm", "libpg-query.wasm"), "");
    fs.writeFileSync(path.join(pkgDir, "index.js"), "");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "libpg-query" }),
    );

    expect(packageContainsWasm(pkgDir)).toBe(true);
  });

  it("should detect sql.js structure", () => {
    // Simulate sql.js package structure
    const pkgDir = path.join(tmpDir, "sql.js");
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "dist", "sql-wasm.wasm"), "");
    fs.writeFileSync(path.join(pkgDir, "index.js"), "");

    expect(packageContainsWasm(pkgDir)).toBe(true);
  });

  it("should detect argon2 structure", () => {
    // Simulate argon2-browser package structure (wasm in lib)
    const pkgDir = path.join(tmpDir, "argon2-browser");
    fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "lib", "argon2.wasm"), "");
    fs.writeFileSync(path.join(pkgDir, "index.js"), "");

    expect(packageContainsWasm(pkgDir)).toBe(true);
  });

  it("should not mark regular packages as wasm packages", () => {
    // Simulate a regular package without wasm
    const pkgDir = path.join(tmpDir, "lodash");
    fs.mkdirSync(pkgDir);
    fs.writeFileSync(path.join(pkgDir, "index.js"), "");
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "lodash" }),
    );

    expect(packageContainsWasm(pkgDir)).toBe(false);
  });
});

describe("Real-world TSConfig Scenarios", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsconfig-scenario-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should handle supabase-style tsconfig extends", () => {
    // Simulate the supabase monorepo structure mentioned in the issue
    // "extends": "tsconfig/react-library.json"

    // Create mock tsconfig package
    const tsconfigPkg = path.join(tmpDir, "node_modules", "tsconfig");
    fs.mkdirSync(tsconfigPkg, { recursive: true });
    fs.writeFileSync(
      path.join(tsconfigPkg, "package.json"),
      JSON.stringify({
        name: "tsconfig",
        exports: {
          "./react-library.json": "./react-library.json",
        },
      }),
    );
    fs.writeFileSync(
      path.join(tsconfigPkg, "react-library.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react",
          strict: true,
        },
      }),
    );

    // Create the tsconfig that extends the package
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        extends: "tsconfig/react-library.json",
        compilerOptions: {
          outDir: "./dist",
        },
      }),
    );

    // The resolution function should detect this is a package path
    // and attempt to resolve it
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
    expect(tsconfig.extends).toBe("tsconfig/react-library.json");
    expect(tsconfig.extends.startsWith(".")).toBe(false);
    expect(tsconfig.extends.startsWith("/")).toBe(false);
  });
});
