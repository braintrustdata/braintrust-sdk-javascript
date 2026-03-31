import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const COMMENT_MARKER = "<!-- braintrust-e2e-links -->";
const DEFAULT_APP_URL = "https://www.braintrust.dev";
const DEFAULT_PROJECT_NAME = "sdk-e2e-tests";
const DEFAULT_VARIANT_KEY = "default";
const DEFAULT_SCENARIO_CONFIG = path.resolve(
  process.cwd(),
  "e2e/config/pr-comment-scenarios.json",
);

function parseArgs(argv) {
  const args = { configPath: null, outputPath: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      args.configPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--output") {
      args.outputPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
  }

  return args;
}

function quoteFilterValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function markdownInlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function scenarioPredicate(metadataScenario) {
  return `metadata.scenario = ${quoteFilterValue(metadataScenario)}`;
}

function testRunIdPredicate(testRunIds) {
  return testRunIds
    .map((id) => `metadata.testRunId = ${quoteFilterValue(id)}`)
    .join(" OR ");
}

function btqlFilterClause(predicate) {
  const encoded = encodeURIComponent(predicate);
  return {
    label: encoded,
    originType: "btql",
    text: encoded,
  };
}

function buildSearchParam(metadataScenario, testRunIds) {
  return JSON.stringify({
    filter: [
      btqlFilterClause(scenarioPredicate(metadataScenario)),
      btqlFilterClause(testRunIdPredicate(testRunIds)),
    ],
  });
}

async function readScenarioConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Scenario config must be an array: ${configPath}`);
  }

  return parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.scenarioDirName !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.metadataScenario !== "string"
    ) {
      throw new Error(
        `Invalid scenario entry at index ${index} in ${configPath}`,
      );
    }

    const variants = Array.isArray(entry.variants)
      ? entry.variants.map((variantEntry, variantIndex) => {
          if (
            !variantEntry ||
            typeof variantEntry !== "object" ||
            typeof variantEntry.variantKey !== "string" ||
            typeof variantEntry.label !== "string"
          ) {
            throw new Error(
              `Invalid variant at scenario index ${index}, variant index ${variantIndex} in ${configPath}`,
            );
          }

          const variantKey = variantEntry.variantKey.trim();
          const variantLabel = variantEntry.label.trim();
          if (!variantKey || !variantLabel) {
            throw new Error(
              `Variant key/label must be non-empty at scenario index ${index}, variant index ${variantIndex} in ${configPath}`,
            );
          }

          return {
            label: variantLabel,
            variantKey,
          };
        })
      : [];

    return {
      label: entry.label,
      metadataScenario: entry.metadataScenario,
      scenarioDirName: entry.scenarioDirName,
      variants,
    };
  });
}

async function readRunContextRecords(runContextDir) {
  const runIdsByScenarioAndVariant = new Map();
  if (!runContextDir) {
    return runIdsByScenarioAndVariant;
  }

  const entries = await readdir(runContextDir, { withFileTypes: true });
  const ndjsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
    .map((entry) => path.join(runContextDir, entry.name))
    .sort();

  for (const filePath of ndjsonFiles) {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");

    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(
          `Invalid JSON in ${filePath}:${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.scenarioDirName !== "string" ||
        typeof parsed.testRunId !== "string"
      ) {
        continue;
      }

      const scenarioDirName = parsed.scenarioDirName;
      const variantKey =
        typeof parsed.variantKey === "string" && parsed.variantKey.trim()
          ? parsed.variantKey.trim()
          : DEFAULT_VARIANT_KEY;
      if (!runIdsByScenarioAndVariant.has(scenarioDirName)) {
        runIdsByScenarioAndVariant.set(scenarioDirName, new Map());
      }

      const variants = runIdsByScenarioAndVariant.get(scenarioDirName);
      if (!variants.has(variantKey)) {
        variants.set(variantKey, new Set());
      }
      variants.get(variantKey).add(parsed.testRunId);
    }
  }

  return runIdsByScenarioAndVariant;
}

async function resolveOrgName() {
  const configuredOrgName = process.env.BRAINTRUST_ORG_NAME?.trim();
  if (configuredOrgName) {
    return { orgName: configuredOrgName, warning: null };
  }

  const apiKey = process.env.BRAINTRUST_API_KEY?.trim();
  if (!apiKey) {
    return {
      orgName: null,
      warning:
        "Could not resolve Braintrust organization name because `BRAINTRUST_ORG_NAME` and `BRAINTRUST_API_KEY` are not set.",
    };
  }

  const appUrl = process.env.BRAINTRUST_APP_URL || DEFAULT_APP_URL;
  let response;
  try {
    response = await fetch(new URL("/api/apikey/login", appUrl), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } catch (error) {
    return {
      orgName: null,
      warning: `Could not resolve Braintrust organization name from ${appUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!response.ok) {
    return {
      orgName: null,
      warning: `Could not resolve Braintrust organization name from ${appUrl}: HTTP ${response.status} ${response.statusText}`,
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      orgName: null,
      warning: `Could not parse Braintrust login response: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const orgInfo = Array.isArray(payload?.org_info) ? payload.org_info : [];
  const firstOrgName = orgInfo.find(
    (org) => typeof org?.name === "string",
  )?.name;

  if (!firstOrgName) {
    return {
      orgName: null,
      warning:
        "Could not resolve Braintrust organization name from login response.",
    };
  }

  return { orgName: firstOrgName, warning: null };
}

function buildLogsUrl({ appUrl, orgName, projectName, search }) {
  const url = new URL(
    `/app/${encodeURIComponent(orgName)}/p/${encodeURIComponent(projectName)}/logs`,
    appUrl,
  );
  url.searchParams.set("tvt", "trace");
  url.searchParams.set("search", search);
  return url.toString();
}

function buildCommentBody(options) {
  const includeCommentMarker =
    process.env.BRAINTRUST_E2E_INCLUDE_COMMENT_MARKER === "1";
  const branchName =
    process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "unknown";
  const repository = process.env.GITHUB_REPOSITORY || "unknown";
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl =
    process.env.GITHUB_SERVER_URL && repository && runId
      ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`
      : null;

  const lines = [
    ...(includeCommentMarker ? [COMMENT_MARKER] : []),
    "## E2E Braintrust Scenario Links",
    "",
    `- Branch: ${markdownInlineCode(branchName)}`,
    `- Project: ${markdownInlineCode(options.projectName)}`,
    runUrl ? `- Workflow run: [${runId}](${runUrl})` : null,
    "",
  ].filter((line) => line !== null);

  if (options.warning) {
    lines.push(`> Warning: ${options.warning}`);
    lines.push("");
  }

  if (options.recordsFound === 0) {
    lines.push("> No e2e run-context records were found for this run.");
    lines.push("");
  }

  lines.push("| Scenario | Braintrust Logs | Status |");
  lines.push("| --- | --- | --- |");

  const pushScenarioRow = ({
    rowLabel,
    metadataScenario,
    observedRunIds,
    statusSuffix,
  }) => {
    if (observedRunIds.length === 0) {
      lines.push(`| ${rowLabel} | N/A | Not observed in this run |`);
      return;
    }

    if (!options.orgName) {
      lines.push(`| ${rowLabel} | N/A | Observed (link unavailable) |`);
      return;
    }

    const search = buildSearchParam(metadataScenario, observedRunIds);
    const logsUrl = buildLogsUrl({
      appUrl: options.appPublicUrl,
      orgName: options.orgName,
      projectName: options.projectName,
      search,
    });
    const runCount = observedRunIds.length;
    const runWord = runCount === 1 ? "run" : "runs";
    const status = statusSuffix
      ? `Observed (${runCount} ${runWord}, ${statusSuffix})`
      : `Observed (${runCount} ${runWord})`;

    lines.push(`| ${rowLabel} | [Open logs](${logsUrl}) | ${status} |`);
  };

  for (const scenario of options.scenarios) {
    const observedVariants =
      options.runIdsByScenarioAndVariant.get(scenario.scenarioDirName) ??
      new Map();
    const configuredVariants = Array.isArray(scenario.variants)
      ? scenario.variants
      : [];
    const hasConfiguredVariants = configuredVariants.length > 0;

    if (!hasConfiguredVariants) {
      const observedRunIds = [
        ...new Set(
          [...observedVariants.values()].flatMap((runIds) => [...runIds]),
        ),
      ].sort();
      pushScenarioRow({
        metadataScenario: scenario.metadataScenario,
        observedRunIds,
        rowLabel: scenario.label,
      });
      continue;
    }

    const configuredVariantKeys = new Set(
      configuredVariants.map((variant) => variant.variantKey),
    );

    for (const variant of configuredVariants) {
      const observedRunIds = [
        ...(observedVariants.get(variant.variantKey) ?? []),
      ].sort();
      pushScenarioRow({
        metadataScenario: scenario.metadataScenario,
        observedRunIds,
        rowLabel: `${scenario.label} (${variant.label})`,
      });
    }

    const extraVariantKeys = [...observedVariants.keys()]
      .filter((variantKey) => !configuredVariantKeys.has(variantKey))
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );
    for (const variantKey of extraVariantKeys) {
      const observedRunIds = [
        ...(observedVariants.get(variantKey) ?? []),
      ].sort();
      pushScenarioRow({
        metadataScenario: scenario.metadataScenario,
        observedRunIds,
        rowLabel: `${scenario.label} (${variantKey})`,
        statusSuffix: "unconfigured variant",
      });
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath =
    args.configPath ||
    process.env.BRAINTRUST_E2E_PR_COMMENT_SCENARIOS ||
    DEFAULT_SCENARIO_CONFIG;
  const runContextDir = process.env.BRAINTRUST_E2E_RUN_CONTEXT_DIR?.trim();
  if (!runContextDir) {
    throw new Error(
      "Missing required env var `BRAINTRUST_E2E_RUN_CONTEXT_DIR`.",
    );
  }

  const [scenarios, runIdsByScenarioAndVariant, orgResult] = await Promise.all([
    readScenarioConfig(configPath),
    readRunContextRecords(runContextDir),
    resolveOrgName(),
  ]);

  const recordsFound = [...runIdsByScenarioAndVariant.values()].reduce(
    (count, variants) =>
      count +
      [...variants.values()].reduce(
        (variantCount, runIds) => variantCount + runIds.size,
        0,
      ),
    0,
  );
  const projectName =
    process.env.BRAINTRUST_E2E_PROJECT_NAME || DEFAULT_PROJECT_NAME;
  const appPublicUrl =
    process.env.BRAINTRUST_APP_PUBLIC_URL ||
    process.env.BRAINTRUST_APP_URL ||
    DEFAULT_APP_URL;

  const body = buildCommentBody({
    appPublicUrl,
    orgName: orgResult.orgName,
    projectName,
    recordsFound,
    runIdsByScenarioAndVariant,
    scenarios,
    warning: orgResult.warning,
  });

  if (args.outputPath) {
    await writeFile(args.outputPath, body, "utf8");
  }

  process.stdout.write(body);
}

await main();
