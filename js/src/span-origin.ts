import iso from "./isomorph";

declare const __BRAINTRUST_SDK_VERSION__: string;

export type SpanOriginEnvironment = {
  type?: string;
  name?: string;
};

type SpanOrigin = {
  name: string;
  version: string;
  instrumentation: { name: string };
  environment?: SpanOriginEnvironment;
};

const SDK_VERSION =
  typeof __BRAINTRUST_SDK_VERSION__ !== "undefined"
    ? __BRAINTRUST_SDK_VERSION__
    : "0.0.0";

export function detectSpanOriginEnvironment(
  explicit?: SpanOriginEnvironment,
): SpanOriginEnvironment | undefined {
  if (explicit) return explicit;

  const envType = iso.getEnv("BRAINTRUST_ENVIRONMENT_TYPE");
  const envName = iso.getEnv("BRAINTRUST_ENVIRONMENT_NAME");
  if (envType || envName) {
    return {
      ...(envType ? { type: envType } : {}),
      ...(envName ? { name: envName } : {}),
    };
  }

  const ci = firstPresent([
    ["GITHUB_ACTIONS", "github_actions"],
    ["GITLAB_CI", "gitlab_ci"],
    ["CIRCLECI", "circleci"],
    ["BUILDKITE", "buildkite"],
    ["JENKINS_URL", "jenkins"],
    ["JENKINS_HOME", "jenkins"],
    ["TF_BUILD", "azure_pipelines"],
    ["TEAMCITY_VERSION", "teamcity"],
    ["TRAVIS", "travis"],
    ["BITBUCKET_BUILD_NUMBER", "bitbucket"],
  ]);
  if (ci) return { type: "ci", name: ci };
  if (iso.getEnv("CI")) return { type: "ci", name: "ci" };

  const earlyServer = firstPresent([
    ["VERCEL", "vercel"],
    ["NETLIFY", "netlify"],
  ]);
  if (earlyServer) return { type: "server", name: earlyServer };
  if (
    iso.getEnv("ECS_CONTAINER_METADATA_URI") ||
    iso.getEnv("ECS_CONTAINER_METADATA_URI_V4")
  ) {
    return { type: "server", name: "ecs" };
  }
  const awsExecutionEnv = iso.getEnv("AWS_EXECUTION_ENV");
  if (awsExecutionEnv?.startsWith("AWS_ECS_")) {
    return { type: "server", name: "ecs" };
  }
  if (awsExecutionEnv?.startsWith("AWS_Lambda_")) {
    return { type: "server", name: "aws_lambda" };
  }
  if (iso.getEnv("AWS_LAMBDA_FUNCTION_NAME")) {
    return { type: "server", name: "aws_lambda" };
  }

  const server = firstPresent([
    ["K_SERVICE", "cloud_run"],
    ["FUNCTION_TARGET", "gcp_functions"],
    ["KUBERNETES_SERVICE_HOST", "kubernetes"],
    ["DYNO", "heroku"],
    ["FLY_APP_NAME", "fly"],
    ["RAILWAY_ENVIRONMENT", "railway"],
    ["RENDER_SERVICE_NAME", "render"],
  ]);
  if (server) return { type: "server", name: server };

  return deploymentModeEnvironment("NODE_ENV", iso.getEnv("NODE_ENV"));
}

function makeSpanOrigin(
  instrumentationName: string,
  environment?: SpanOriginEnvironment,
): SpanOrigin {
  return {
    name: "braintrust.sdk.javascript",
    version: SDK_VERSION,
    instrumentation: { name: instrumentationName },
    ...(environment ? { environment } : {}),
  };
}

export function mergeSpanOriginContext(
  context: Record<string, unknown> | undefined,
  instrumentationName: string,
  environment?: SpanOriginEnvironment,
): Record<string, unknown> {
  const next = { ...(context ?? {}) };
  const current = isObject(next.span_origin) ? { ...next.span_origin } : {};
  next.span_origin = {
    ...makeSpanOrigin(instrumentationName, environment),
    ...current,
  };
  return next;
}

function firstPresent(entries: Array<[string, string]>): string | undefined {
  return entries.find(([key]) => Boolean(iso.getEnv(key)))?.[1];
}

function deploymentModeEnvironment(
  _key: string,
  value: string | undefined,
): SpanOriginEnvironment | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "production" || normalized === "staging") {
    return { type: "server", name: normalized };
  }
  if (normalized === "development" || normalized === "local") {
    return { type: "local", name: normalized };
  }
  return { name: value };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
