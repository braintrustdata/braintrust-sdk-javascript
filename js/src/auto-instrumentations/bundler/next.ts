import { createRequire } from "node:module";
import { join } from "node:path";
import { webpackPlugin } from "./webpack";

type MaybePromise<T> = T | Promise<T>;
type NextConfigFunction = (
  this: unknown,
  ...args: unknown[]
) => MaybePromise<NextConfigObject | undefined>;
type ExportedNextConfig = NextConfigObject | NextConfigFunction;

interface WebpackBuildContext {
  isServer?: boolean;
  nextRuntime?: string;
}

interface WebpackConfig {
  plugins?: unknown[];
  [key: string]: unknown;
}

interface TurbopackConfig {
  resolveAlias?: Record<string, unknown>;
  rules?: Record<string, unknown>;
  [key: string]: unknown;
}

interface NextConfigObject {
  experimental?: {
    turbo?: TurbopackConfig;
    [key: string]: unknown;
  };
  turbopack?: TurbopackConfig;
  webpack?:
    | ((config: WebpackConfig, context: WebpackBuildContext) => unknown)
    | null;
  [key: string]: unknown;
}

// Resolve the loader from the app's package graph, because Next evaluates this
// from the user's config file rather than from our source tree.
const requireFromProject = createRequire(join(process.cwd(), "package.json"));
const TURBOPACK_RULE_MATCHER = "*.{js,mjs,cjs}";

export function wrapNextjsConfigWithBraintrust<C>(nextConfig: C): C {
  // Preserve the exported config shape: object configs stay objects, function
  // configs stay functions, and async function configs are patched after they
  // resolve.
  const castNextConfig = (nextConfig ?? {}) as ExportedNextConfig;
  if (typeof castNextConfig === "function") {
    return function (
      this: unknown,
      ...args: unknown[]
    ): ReturnType<NextConfigFunction> {
      const maybeConfig = castNextConfig.apply(this, args);
      if (isThenable<NextConfigObject | undefined>(maybeConfig)) {
        return maybeConfig.then((resolvedConfig) =>
          createConfigObject(resolvedConfig),
        );
      }

      return createConfigObject(maybeConfig as NextConfigObject);
    } as C;
  }

  return createConfigObject(castNextConfig) as C;
}

function createConfigObject(
  nextConfig: NextConfigObject | undefined,
): NextConfigObject {
  const config = { ...(nextConfig ?? {}) };
  const activeBundler = detectBundler();

  if (activeBundler === "turbopack") {
    // Next has used both `experimental.turbo` and `turbopack`; patch the stable
    // key when present, otherwise preserve apps already using the older shape.
    if (config.turbopack || !config.experimental?.turbo) {
      return {
        ...config,
        turbopack: wrapTurbopackConfig(config.turbopack),
      };
    }

    return {
      ...config,
      experimental: {
        ...config.experimental,
        turbo: wrapTurbopackConfig(config.experimental.turbo),
      },
    };
  }

  return {
    ...config,
    webpack: wrapWebpackConfig(config.webpack),
  };
}

function detectBundler(): "turbopack" | "webpack" {
  if (process.argv.includes("--webpack")) {
    return "webpack";
  }

  // At config-evaluation time there is no compiler object yet, so the most
  // direct Turbopack signal is the environment/CLI flag Next sets for that
  // build.
  const turbopackEnv = process.env.TURBOPACK?.trim().toLowerCase();
  if (
    (turbopackEnv && turbopackEnv !== "0" && turbopackEnv !== "false") ||
    process.argv.includes("--turbo") ||
    process.argv.includes("--turbopack")
  ) {
    return "turbopack";
  }

  // Next 16 defaults production builds to Turbopack unless the user passes
  // `--webpack`, so use the installed Next major as a final auto-detection
  // signal when no explicit bundler flag is present.
  const nextMajorVersion = getNextMajorVersion();
  if (nextMajorVersion !== undefined && nextMajorVersion >= 16) {
    return "turbopack";
  }

  return "webpack";
}

function wrapWebpackConfig(
  userWebpack: NextConfigObject["webpack"],
): NonNullable<NextConfigObject["webpack"]> {
  return (incomingConfig, buildContext) => {
    const rawConfig =
      typeof userWebpack === "function"
        ? userWebpack(incomingConfig, buildContext)
        : incomingConfig;
    const config = ((rawConfig as WebpackConfig | undefined) ??
      incomingConfig) as WebpackConfig;
    const existingPlugins = Array.isArray(config.plugins) ? config.plugins : [];

    const runtime = buildContext.isServer
      ? buildContext.nextRuntime === "edge" ||
        buildContext.nextRuntime === "experimental-edge"
        ? "edge"
        : "server"
      : "client";

    const plugin = webpackPlugin({
      browser: runtime === "client" || runtime === "edge",
    });

    return {
      ...config,
      plugins: [...existingPlugins, plugin],
    };
  };
}

function wrapTurbopackConfig(
  turbopackConfig: TurbopackConfig | undefined,
): TurbopackConfig {
  const config = { ...(turbopackConfig ?? {}) };
  const rules =
    config.rules &&
    typeof config.rules === "object" &&
    !Array.isArray(config.rules)
      ? config.rules
      : {};
  return {
    ...config,
    rules: addBraintrustTurbopackRule(rules),
  };
}

function addBraintrustTurbopackRule(
  rules: Record<string, unknown>,
): Record<string, unknown> {
  const loaderPath = getWebpackLoaderPath();
  const braintrustRules = [
    {
      condition: { all: ["foreign", "browser"] },
      loaders: [
        {
          loader: loaderPath,
          options: { browser: true },
        },
      ],
    },
    {
      condition: { all: ["foreign", "edge-light"] },
      loaders: [
        {
          loader: loaderPath,
          options: { browser: true },
        },
      ],
    },
    {
      condition: { all: ["foreign", "node"] },
      loaders: [
        {
          loader: loaderPath,
          options: { browser: false },
        },
      ],
    },
  ];
  const existingRule = rules[TURBOPACK_RULE_MATCHER];

  if (!existingRule) {
    return {
      ...rules,
      // Turbopack exposes the active runtime through rule conditions, so keep
      // client, edge, and node transforms separate instead of inferring later.
      [TURBOPACK_RULE_MATCHER]: braintrustRules,
    };
  }

  if (Array.isArray(existingRule)) {
    return {
      ...rules,
      [TURBOPACK_RULE_MATCHER]: [...existingRule, ...braintrustRules],
    };
  }

  if (typeof existingRule === "object" && existingRule !== null) {
    return {
      ...rules,
      [TURBOPACK_RULE_MATCHER]: [existingRule, ...braintrustRules],
    };
  }

  return rules;
}

function getWebpackLoaderPath(): string {
  try {
    return requireFromProject.resolve("braintrust/webpack-loader");
  } catch {
    return "braintrust/webpack-loader";
  }
}

function getNextMajorVersion(): number | undefined {
  try {
    const nextPackageJson = requireFromProject("next/package.json") as {
      version?: unknown;
    };
    if (typeof nextPackageJson.version !== "string") {
      return undefined;
    }

    const major = Number.parseInt(nextPackageJson.version.split(".")[0] ?? "");
    return Number.isFinite(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

function isThenable<T>(value: unknown): value is PromiseLike<T> {
  // Do structural thenable detection so async config wrappers work across
  // Promise implementations and module boundaries.
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
