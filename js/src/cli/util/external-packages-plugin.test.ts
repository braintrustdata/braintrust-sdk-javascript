import { describe, it, expect, vi } from "vitest";
import { createMarkKnownPackagesExternalPlugin } from "./external-packages-plugin";

describe("External Packages Plugin", () => {
  describe("createMarkKnownPackagesExternalPlugin", () => {
    it("should create a plugin with the correct name", () => {
      const plugin = createMarkKnownPackagesExternalPlugin();
      expect(plugin.name).toBe("make-known-packages-external");
    });

    it("should mark hardcoded packages as external", () => {
      const plugin = createMarkKnownPackagesExternalPlugin();
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      expect(mockBuild.onResolve).toHaveBeenCalledWith(
        { filter: expect.any(RegExp) },
        expect.any(Function),
      );

      // Get the filter regex that was passed
      const [{ filter }] = mockBuild.onResolve.mock.calls[0];
      const resolveFunction = mockBuild.onResolve.mock.calls[0][1];

      // Test hardcoded packages
      expect(filter.test("braintrust")).toBe(true);
      expect(filter.test("autoevals")).toBe(true);
      expect(filter.test("@mapbox/node-pre-gyp")).toBe(true);
      expect(filter.test("config")).toBe(true);
      expect(filter.test("lightningcss")).toBe(true);

      // Test that the resolve function returns external: true
      expect(resolveFunction({ path: "braintrust" })).toEqual({
        path: "braintrust",
        external: true,
      });
    });

    it("should not mark non-matching packages as external", () => {
      const plugin = createMarkKnownPackagesExternalPlugin();
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Test packages that should NOT match
      expect(filter.test("react")).toBe(false);
      expect(filter.test("lodash")).toBe(false);
      expect(filter.test("@types/node")).toBe(false);
      expect(filter.test("some-random-package")).toBe(false);
    });

    it("should include additional packages from CLI", () => {
      const additionalPackages = ["sqlite3", "fsevents", "@scope/package"];
      const plugin = createMarkKnownPackagesExternalPlugin(additionalPackages);
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Test that additional packages are included
      expect(filter.test("sqlite3")).toBe(true);
      expect(filter.test("fsevents")).toBe(true);
      expect(filter.test("@scope/package")).toBe(true);

      // Test that hardcoded packages still work
      expect(filter.test("braintrust")).toBe(true);
      expect(filter.test("@mapbox/node-pre-gyp")).toBe(true);
    });

    it("should handle packages with subpaths", () => {
      const plugin = createMarkKnownPackagesExternalPlugin();
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Test subpaths
      expect(filter.test("braintrust/core")).toBe(true);
      expect(filter.test("braintrust/dist/index.js")).toBe(true);
      expect(
        filter.test("@mapbox/node-pre-gyp/lib/util/nw-pre-gyp/index.html"),
      ).toBe(true);
    });

    it("should handle special characters in package names", () => {
      const additionalPackages = [
        "@scope/package-with-dashes",
        "package.with.dots",
      ];
      const plugin = createMarkKnownPackagesExternalPlugin(additionalPackages);
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Test packages with special characters
      expect(filter.test("@scope/package-with-dashes")).toBe(true);
      expect(filter.test("package.with.dots")).toBe(true);
    });

    it("should resolve the original @mapbox/node-pre-gyp bundling issue", () => {
      const plugin = createMarkKnownPackagesExternalPlugin();
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];
      const resolveFunction = mockBuild.onResolve.mock.calls[0][1];

      // Test the specific problematic paths from the original issue
      const problematicPaths = [
        "@mapbox/node-pre-gyp",
        "@mapbox/node-pre-gyp/lib/util/nw-pre-gyp/index.html",
        "@mapbox/node-pre-gyp/lib/util/s3_setup.js",
        "@mapbox/node-pre-gyp/lib/node-pre-gyp.js",
      ];

      problematicPaths.forEach((path) => {
        expect(filter.test(path)).toBe(true);
        expect(resolveFunction({ path })).toEqual({
          path,
          external: true,
        });
      });
    });

    it("should prevent false positives with similar package names", () => {
      const plugin = createMarkKnownPackagesExternalPlugin();
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Test cases that should NOT match (false positives)
      const falsePositives = [
        "braintrust-extended",
        "my-braintrust",
        "config-loader",
        "lightningcss-plugin",
        "sqlite3-wrapper",
        "better-sqlite3",
        "node-pre-gyp", // Similar to @mapbox/node-pre-gyp but different
        "@other/braintrust",
      ];

      falsePositives.forEach((packageName) => {
        expect(filter.test(packageName)).toBe(false);
      });

      // Test cases that SHOULD match (true positives)
      const truePositives = [
        "braintrust",
        "braintrust/core",
        "braintrust/dist/index.js",
        "@mapbox/node-pre-gyp",
        "@mapbox/node-pre-gyp/lib/util/nw-pre-gyp/index.html",
        "config",
        "lightningcss",
      ];

      truePositives.forEach((packageName) => {
        expect(filter.test(packageName)).toBe(true);
      });
    });

    it("should handle prefix matching vs exact matching correctly", () => {
      const plugin = createMarkKnownPackagesExternalPlugin();
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Test prefix matching for @braintrust/ (ends with /)
      const braintrustPrefixTests = [
        {
          input: "@braintrust/utils",
          expected: true,
          description: "Should match @braintrust/ prefix",
        },
        {
          input: "@braintrust-other/core",
          expected: false,
          description: "Should not match similar but different scope",
        },
      ];

      // Test exact matching for config (doesn't end with /)
      const configExactTests = [
        {
          input: "config",
          expected: true,
          description: "Should match config exactly",
        },
        {
          input: "config/local",
          expected: true,
          description: "Should match config with subpath",
        },
        {
          input: "config-loader",
          expected: false,
          description: "Should not match config with suffix",
        },
        {
          input: "my-config",
          expected: false,
          description: "Should not match config with prefix",
        },
      ];

      // Test exact matching for braintrust (doesn't end with /)
      const braintrustExactTests = [
        {
          input: "braintrust",
          expected: true,
          description: "Should match braintrust exactly",
        },
        {
          input: "braintrust/core",
          expected: true,
          description: "Should match braintrust with subpath",
        },
        {
          input: "braintrust-extended",
          expected: false,
          description: "Should not match braintrust with suffix",
        },
        {
          input: "my-braintrust",
          expected: false,
          description: "Should not match braintrust with prefix",
        },
      ];

      const allTests = [
        ...braintrustPrefixTests,
        ...configExactTests,
        ...braintrustExactTests,
      ];

      allTests.forEach((test) => {
        const result = filter.test(test.input);
        expect(result).toBe(test.expected);
      });
    });
  });

  describe("Regex Edge Cases", () => {
    it("should handle empty additional packages array", () => {
      const plugin = createMarkKnownPackagesExternalPlugin([]);
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Should still work with hardcoded packages
      expect(filter.test("braintrust")).toBe(true);
      expect(filter.test("@mapbox/node-pre-gyp")).toBe(true);
    });

    it("should handle undefined additional packages", () => {
      const plugin = createMarkKnownPackagesExternalPlugin(undefined);
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Should still work with hardcoded packages
      expect(filter.test("braintrust")).toBe(true);
      expect(filter.test("@mapbox/node-pre-gyp")).toBe(true);
    });

    it("should handle duplicate packages", () => {
      const additionalPackages = ["braintrust", "sqlite3", "braintrust"]; // duplicate
      const plugin = createMarkKnownPackagesExternalPlugin(additionalPackages);
      const mockBuild = {
        onResolve: vi.fn(),
      };

      plugin.setup(mockBuild as any);

      const [{ filter }] = mockBuild.onResolve.mock.calls[0];

      // Should still work correctly
      expect(filter.test("braintrust")).toBe(true);
      expect(filter.test("sqlite3")).toBe(true);
    });
  });
});
