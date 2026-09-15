import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireFromProject } = vi.hoisted(() => ({
  requireFromProject: Object.assign(vi.fn(), {
    resolve: vi.fn(() => "/braintrust/webpack-loader.cjs"),
  }),
}));

vi.mock("node:module", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:module")>()),
  createRequire: () => requireFromProject,
}));

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
    requireFromProject.mockImplementation(() => {
      throw new Error("Cannot find module next/package.json");
    });
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
    expect(config.turbopack.resolveAlias).toBeUndefined();
    expect(config.turbopack.rules["*.css"]).toEqual({
      loaders: ["css-loader"],
    });
  });

  it("preserves user Turbopack aliases", () => {
    process.env.TURBOPACK = "1";

    const config = wrapNextjsConfigWithBraintrust({
      turbopack: {
        resolveAlias: {
          "user-module": "/custom/user-module.js",
        },
        rules: {},
      },
    }) as any;

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

  it("uses Turbopack by default for Next versions that default to Turbopack builds", () => {
    requireFromProject.mockReturnValue({ version: "16.2.1" });

    const config = wrapNextjsConfigWithBraintrust({}) as any;

    expect(config.turbopack.rules["*.{js,mjs,cjs}"]).toHaveLength(3);
    expect(config.webpack).toBeUndefined();
  });

  it.each(["13.2.0", "13.5.11", "14.2.35", "14.3.0-canary.87"])(
    "enables the instrumentation hook on Next %s",
    (version) => {
      requireFromProject.mockReturnValue({ version });

      const config = wrapNextjsConfigWithBraintrust({}) as any;

      expect(config.experimental.instrumentationHook).toBe(true);
    },
  );

  it.each(["15.0.0", "15.0.0-rc.1", "16.2.1", "16.3.0-canary.1"])(
    "does not add the experimental instrumentation hook on Next %s",
    (version) => {
      requireFromProject.mockReturnValue({ version });

      const config = wrapNextjsConfigWithBraintrust({}) as any;

      expect(config.experimental).toBeUndefined();
    },
  );

  it.each([{}, { version: 14 }, { version: "invalid" }])(
    "does not add the instrumentation hook when the Next version is invalid: %j",
    (packageJson) => {
      requireFromProject.mockReturnValue(packageJson);

      const config = wrapNextjsConfigWithBraintrust({}) as any;

      expect(config.experimental).toBeUndefined();
    },
  );

  it("does not add the instrumentation hook when Next cannot be resolved", () => {
    const config = wrapNextjsConfigWithBraintrust({}) as any;

    expect(config.experimental).toBeUndefined();
  });

  it.each([undefined, false, true])(
    "enables the hook while preserving experimental options without mutation (existing flag: %s)",
    (instrumentationHook) => {
      requireFromProject.mockReturnValue({ version: "14.2.35" });
      process.argv.push("--webpack");
      const original = Object.freeze({
        experimental: Object.freeze({ instrumentationHook, cpus: 2 }),
      });

      const config = wrapNextjsConfigWithBraintrust(original);

      expect(config.experimental).toEqual({
        instrumentationHook: true,
        cpus: 2,
      });
      expect(original.experimental.instrumentationHook).toBe(
        instrumentationHook,
      );
    },
  );

  it.each([false, true])(
    "enables the hook for function configs (async: %s)",
    async (asyncConfig) => {
      requireFromProject.mockReturnValue({ version: "14.2.35" });
      const userConfig = { experimental: { cpus: 2 } };
      const config = wrapNextjsConfigWithBraintrust(
        asyncConfig ? async () => userConfig : () => userConfig,
      );

      expect((await config()).experimental).toEqual({
        instrumentationHook: true,
        cpus: 2,
      });
      expect(userConfig.experimental).toEqual({ cpus: 2 });
    },
  );

  it("preserves the injected hook when wrapping experimental Turbopack options", () => {
    requireFromProject.mockReturnValue({ version: "14.2.35" });
    process.argv.push("--turbo");

    const config = wrapNextjsConfigWithBraintrust({
      experimental: { turbo: {} },
    }) as any;

    expect(config.experimental.instrumentationHook).toBe(true);
    expect(config.experimental.turbo.rules["*.{js,mjs,cjs}"]).toHaveLength(3);
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
