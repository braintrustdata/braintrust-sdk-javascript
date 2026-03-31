import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const COMMENT_MARKER = "<!-- braintrust-e2e-links -->";
const DEFAULT_APP_URL = "https://www.braintrust.dev";
const DEFAULT_PROJECT_NAME = "sdk-e2e-tests";
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

function scenarioFilterExpression(metadataScenario, testRunIds) {
  const runIdPredicates = testRunIds
    .map((id) => `metadata.testRunId = ${quoteFilterValue(id)}`)
    .join(" OR ");

  return `metadata.scenario = ${quoteFilterValue(metadataScenario)} AND (${runIdPredicates})`;
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

    return {
      label: entry.label,
      metadataScenario: entry.metadataScenario,
      scenarioDirName: entry.scenarioDirName,
    };
  });
}

async function readRunContextRecords(runContextDir) {
  const runIdsByScenario = new Map();
  if (!runContextDir) {
    return runIdsByScenario;
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

      if (!runIdsByScenario.has(parsed.scenarioDirName)) {
        runIdsByScenario.set(parsed.scenarioDirName, new Set());
      }
      runIdsByScenario.get(parsed.scenarioDirName).add(parsed.testRunId);
    }
  }

  return runIdsByScenario;
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

  lines.push("| Scenario | Braintrust Logs | testRunIds | Status |");
  lines.push("| --- | --- | --- | --- |");

  for (const scenario of options.scenarios) {
    const observedRunIds = [
      ...(options.runIdsByScenario.get(scenario.scenarioDirName) ?? []),
    ].sort();
    let logsCell = "N/A";
    let status = "Not observed in this run";

    if (observedRunIds.length > 0) {
      if (options.orgName) {
        const search = scenarioFilterExpression(
          scenario.metadataScenario,
          observedRunIds,
        );
        const logsUrl = buildLogsUrl({
          appUrl: options.appPublicUrl,
          orgName: options.orgName,
          projectName: options.projectName,
          search,
        });
        logsCell = `[Open logs](${logsUrl})`;
        status = "Observed";
      } else {
        status = "Observed (link unavailable)";
      }
    }

    const runIdsCell =
      observedRunIds.length > 0
        ? observedRunIds.map(markdownInlineCode).join(", ")
        : markdownInlineCode("-");

    lines.push(
      `| ${scenario.label} | ${logsCell} | ${runIdsCell} | ${status} |`,
    );
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

  const [scenarios, runIdsByScenario, orgResult] = await Promise.all([
    readScenarioConfig(configPath),
    readRunContextRecords(runContextDir),
    resolveOrgName(),
  ]);

  const recordsFound = [...runIdsByScenario.values()].reduce(
    (count, runIds) => count + runIds.size,
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
    runIdsByScenario,
    scenarios,
    warning: orgResult.warning,
  });

  if (args.outputPath) {
    await writeFile(args.outputPath, body, "utf8");
  }

  process.stdout.write(body);
}

await main();
