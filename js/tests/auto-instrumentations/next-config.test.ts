import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/auto-instrumentations/bundler/webpack.js", () => ({
  webpackPlugin: vi.fn((options: unknown) => ({
    apply: () => {},
    name: "braintrust-test-webpack-plugin",
    options,
  })),
}));

import { webpackPlugin } from "../../src/auto-instrumentations/bundler/webpack.js";
import { wrapNextjsConfigWithBraintrust } from "../../src/auto-instrumentations/bundler/next.js";

const originalArgv = [...process.argv];
const originalTurbopackEnv = process.env.TURBOPACK;

describe("wrapNextjsConfigWithBraintrust", () => {
  beforeEach(() => {
    delete process.env.TURBOPACK;
    process.argv = originalArgv.filter(
      (arg) =>
        arg !== "--turbo" && arg !== "--turbopack" && arg !== "--webpack",
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalTurbopackEnv === undefined) {
      delete process.env.TURBOPACK;
    } else {
      process.env.TURBOPACK = originalTurbopackEnv;
    }
  });

  it("wraps object configs with a webpack plugin by default", () => {
    const userWebpack = vi.fn((config) => ({
      ...config,
      plugins: [...config.plugins, { name: "user-plugin" }],
    }));
    const config = wrapNextjsConfigWithBraintrust({
      webpack: userWebpack,
    }) as any;

    const result = config.webpack({ plugins: [] }, { isServer: false });

    expect(userWebpack).toHaveBeenCalledOnce();
    expect(webpackPlugin).toHaveBeenCalledWith({ browser: true });
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0]).toEqual({ name: "user-plugin" });
    expect(result.plugins[1].options).toEqual({ browser: true });
  });

  it("passes browser false for node server webpack builds", () => {
    const config = wrapNextjsConfigWithBraintrust({}) as any;

    const result = config.webpack(
      { plugins: [] },
      { isServer: true, nextRuntime: "nodejs" },
    );

    expect(result.plugins[0].options).toEqual({ browser: false });
  });

  it.each(["edge", "experimental-edge"])(
    "passes browser true for %s webpack builds",
    (nextRuntime) => {
      const config = wrapNextjsConfigWithBraintrust({}) as any;

      const result = config.webpack(
        { plugins: [] },
        { isServer: true, nextRuntime },
      );

      expect(result.plugins[0].options).toEqual({ browser: true });
    },
  );

  it("supports async function configs", async () => {
    const config = wrapNextjsConfigWithBraintrust(async (phase: string) => ({
      env: { phase },
    })) as any;

    const result = await config("phase-production-build");

    expect(result.env).toEqual({ phase: "phase-production-build" });
    expect(typeof result.webpack).toBe("function");
  });

  it("adds a Turbopack loader rule when Turbopack is active", () => {
    process.env.TURBOPACK = "1";

    const config = wrapNextjsConfigWithBraintrust({
      turbopack: {
        rules: {
          "*.css": { loaders: ["css-loader"] },
        },
      },
    }) as any;

    const rules = config.turbopack.rules["*.{js,mjs,cjs}"];
    expect(rules).toHaveLength(3);
    expect(rules).toMatchObject([
      {
        condition: { all: ["foreign", "browser"] },
        loaders: [
          {
            options: { browser: true },
          },
        ],
      },
      {
        condition: { all: ["foreign", "edge-light"] },
        loaders: [
          {
            options: { browser: true },
          },
        ],
      },
      {
        condition: { all: ["foreign", "node"] },
        loaders: [
          {
            options: { browser: false },
          },
        ],
      },
    ]);
    expect(
      rules.every((rule: { loaders: Array<{ loader: string }> }) =>
        rule.loaders[0].loader.includes("webpack-loader"),
      ),
    ).toBe(true);
    expect(config.turbopack.resolveAlias["dc-browser"]).toContain("dc-browser");
    expect(config.turbopack.rules["*.css"]).toEqual({
      loaders: ["css-loader"],
    });
  });

  it("preserves user Turbopack aliases", () => {
    process.env.TURBOPACK = "1";

    const config = wrapNextjsConfigWithBraintrust({
      turbopack: {
        resolveAlias: {
          "dc-browser": "/custom/dc-browser.js",
          "user-module": "/custom/user-module.js",
        },
        rules: {},
      },
    }) as any;

    expect(config.turbopack.resolveAlias["dc-browser"]).toBe(
      "/custom/dc-browser.js",
    );
    expect(config.turbopack.resolveAlias["user-module"]).toBe(
      "/custom/user-module.js",
    );
  });

  it("honors explicit webpack builds even when Turbopack env is set", () => {
    process.env.TURBOPACK = "1";
    process.argv = [...process.argv, "--webpack"];

    const config = wrapNextjsConfigWithBraintrust({
      turbopack: {
        rules: {},
      },
    }) as any;

    expect(typeof config.webpack).toBe("function");
    expect(config.turbopack.rules).toEqual({});
  });

  it("uses Turbopack by default for Next versions that default to Turbopack builds", async () => {
    vi.resetModules();
    vi.doMock("node:module", async () => {
      const actual =
        await vi.importActual<typeof import("node:module")>("node:module");
      const mockedRequire = Object.assign(
        (specifier: string) => {
          if (specifier === "next/package.json") {
            return { version: "16.2.1" };
          }

          throw new Error(`Cannot find module ${specifier}`);
        },
        {
          resolve: (specifier: string) => {
            if (specifier === "braintrust/webpack-loader") {
              return "/braintrust/webpack-loader.cjs";
            }

            if (specifier === "braintrust/package.json") {
              return "/braintrust/package.json";
            }

            if (specifier === "dc-browser") {
              return "/braintrust/node_modules/dc-browser/dist/index.js";
            }

            throw new Error(`Cannot resolve module ${specifier}`);
          },
        },
      );

      return {
        ...actual,
        createRequire: () => mockedRequire,
      };
    });

    try {
      const { wrapNextjsConfigWithBraintrust: withMockedBraintrust } =
        await import("../../src/auto-instrumentations/bundler/next.js");

      const config = withMockedBraintrust({}) as any;

      expect(config.turbopack.rules["*.{js,mjs,cjs}"]).toHaveLength(3);
      expect(config.webpack).toBeUndefined();
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
    }
  });

  it("appends to an existing Turbopack rule", () => {
    process.env.TURBOPACK = "1";
    const config = wrapNextjsConfigWithBraintrust({
      turbopack: {
        rules: {
          "*.{js,mjs,cjs}": {
            condition: "foreign",
            loaders: [{ loader: "existing-loader" }],
          },
        },
      },
    }) as any;

    const rules = config.turbopack.rules["*.{js,mjs,cjs}"];
    expect(rules).toHaveLength(4);
    expect(rules[0]).toEqual({
      condition: "foreign",
      loaders: [{ loader: "existing-loader" }],
    });
    expect(
      rules.slice(1).map((rule: { condition: unknown }) => rule.condition),
    ).toEqual([
      { all: ["foreign", "browser"] },
      { all: ["foreign", "edge-light"] },
      { all: ["foreign", "node"] },
    ]);
  });
});
