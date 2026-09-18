import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONVENTIONAL_COMMIT_SUMMARY =
  /^[\p{L}\p{N}][\p{L}\p{N}-]*(?:\([^\s()]+\))?!?: \S.*$/u;

export function getChangesetSummary(contents) {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    return undefined;
  }

  const endOfFrontmatter = lines.indexOf("---", 1);
  if (endOfFrontmatter === -1) {
    return undefined;
  }

  return lines
    .slice(endOfFrontmatter + 1)
    .find((line) => line.trim().length > 0)
    ?.trimEnd();
}

export function isConventionalCommitSummary(summary) {
  return CONVENTIONAL_COMMIT_SUMMARY.test(summary);
}

function main() {
  const changesetDir = path.resolve(".changeset");
  const changesetFiles = readdirSync(changesetDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name.toLowerCase() !== "readme.md",
    )
    .map((entry) => path.join(changesetDir, entry.name))
    .sort();

  const errors = [];
  for (const changesetFile of changesetFiles) {
    const summary = getChangesetSummary(readFileSync(changesetFile, "utf8"));
    const relativePath = path.relative(process.cwd(), changesetFile);

    if (summary === undefined) {
      errors.push(
        `${relativePath} does not have a summary after its frontmatter`,
      );
    } else if (!isConventionalCommitSummary(summary)) {
      errors.push(
        `${relativePath} must start with a Conventional Commit message; found ${JSON.stringify(summary)}`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("Changeset validation failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    console.error(
      "\nExpected: <type>[optional scope][optional !]: <description>",
    );
    console.error("See https://www.conventionalcommits.org/en/v1.0.0/");
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validated Conventional Commit summaries in ${changesetFiles.length} changeset files.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
