import chalk from "chalk";
import { terminalLink } from "termi-link";
import boxen from "boxen";
import Table from "cli-table3";
import pluralize from "pluralize";

import { ExperimentSummary, ScoreSummary, MetricSummary } from "../../logger";
import type { ReporterDef } from "../../reporters/types";
import { EvaluatorDef, EvalResultWithSummary } from "../../framework";
import { isEmpty } from "../../util";

function formatExperimentSummaryFancy(summary: ExperimentSummary) {
  let comparisonLine = "";
  if (summary.comparisonExperimentName) {
    comparisonLine = `${summary.comparisonExperimentName} ${chalk.gray("(baseline)")} ← ${summary.experimentName} ${chalk.gray("(comparison)")}\n\n`;
  }

  const tableParts: string[] = [];

  const hasScores = Object.keys(summary.scores).length > 0;
  const hasMetrics = Object.keys(summary.metrics ?? {}).length > 0;
  const hasComparison = !!summary.comparisonExperimentName;

  if (hasScores || hasMetrics) {
    const headers = [chalk.gray("Name"), chalk.gray("Value")];

    if (hasComparison) {
      headers.push(
        chalk.gray("Change"),
        chalk.gray("Improvements"),
        chalk.gray("Regressions"),
      );
    }

    const combinedTable = new Table({
      head: hasComparison ? headers : [],
      style: { head: [], "padding-left": 0, "padding-right": 0, border: [] },
      chars: {
        top: "",
        "top-mid": "",
        "top-left": "",
        "top-right": "",
        bottom: "",
        "bottom-mid": "",
        "bottom-left": "",
        "bottom-right": "",
        left: "",
        "left-mid": "",
        mid: "",
        "mid-mid": "",
        right: "",
        "right-mid": "",
        middle: " ",
      },
      colWidths: hasComparison ? [18, 10, 10, 13, 12] : [20, 15],
      colAligns: hasComparison
        ? ["left", "right", "right", "right", "right"]
        : ["left", "right"],
      wordWrap: false,
    });

    const scoreValues: ScoreSummary[] = Object.values(summary.scores);
    for (const score of scoreValues) {
      const scorePercent = (score.score * 100).toFixed(2);
      const scoreValue = chalk.white(`${scorePercent}%`);

      let diffString = "";
      if (!isEmpty(score.diff)) {
        const diffPercent = (score.diff! * 100).toFixed(2);
        const diffSign = score.diff! > 0 ? "+" : "";
        const diffColor = score.diff! > 0 ? chalk.green : chalk.red;
        diffString = diffColor(`${diffSign}${diffPercent}%`);
      } else {
        diffString = chalk.gray("-");
      }

      const improvements =
        score.improvements > 0
          ? chalk.dim.green(score.improvements)
          : chalk.gray("-");
      const regressions =
        score.regressions > 0
          ? chalk.dim.red(score.regressions)
          : chalk.gray("-");

      const row = [`${chalk.blue("◯")} ${score.name}`, scoreValue];
      if (hasComparison) {
        row.push(diffString, improvements, regressions);
      }
      combinedTable.push(row);
    }

    const metricValues: MetricSummary[] = Object.values(summary.metrics ?? {});
    for (const metric of metricValues) {
      const fractionDigits = Number.isInteger(metric.metric) ? 0 : 2;
      const formattedValue = metric.metric.toFixed(fractionDigits);
      const metricValue = chalk.white(
        metric.unit === "$"
          ? `${metric.unit}${formattedValue}`
          : `${formattedValue}${metric.unit}`,
      );

      let diffString = "";
      if (!isEmpty(metric.diff)) {
        const diffPercent = (metric.diff! * 100).toFixed(2);
        const diffSign = metric.diff! > 0 ? "+" : "";
        const diffColor = metric.diff! > 0 ? chalk.green : chalk.red;
        diffString = diffColor(`${diffSign}${diffPercent}%`);
      } else {
        diffString = chalk.gray("-");
      }

      const improvements =
        metric.improvements > 0
          ? chalk.dim.green(metric.improvements)
          : chalk.gray("-");
      const regressions =
        metric.regressions > 0
          ? chalk.dim.red(metric.regressions)
          : chalk.gray("-");

      const row = [`${chalk.magenta("◯")} ${metric.name}`, metricValue];
      if (hasComparison) {
        row.push(diffString, improvements, regressions);
      }
      combinedTable.push(row);
    }

    tableParts.push(combinedTable.toString());
  }

  const content = [comparisonLine, ...tableParts].filter(Boolean).join("\n");

  const footer = summary.experimentUrl
    ? terminalLink(
        `View results for ${summary.experimentName}`,
        summary.experimentUrl,
        { fallback: () => `See results at ${summary.experimentUrl}` },
      )
    : "";

  const boxContent = [content, footer].filter(Boolean).join("\n\n");

  try {
    return (
      "\n" +
      boxen(boxContent, {
        title: chalk.gray("Experiment summary"),
        titleAlignment: "left",
        padding: 0.5,
        borderColor: "gray",
        borderStyle: "round",
      })
    );
  } catch {
    return "\n" + chalk.gray("Experiment summary") + "\n" + boxContent + "\n";
  }
}

export const warning = chalk.yellow;

export const fancyReporter: ReporterDef<boolean> = {
  name: "Braintrust fancy reporter",
  async reportEval(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluator: EvaluatorDef<any, any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: EvalResultWithSummary<any, any, any, any>,
    { verbose, jsonl }: { verbose: boolean; jsonl?: boolean },
  ) {
    const { results, summary } = result;
    const failingResults = results.filter(
      (r: { error: unknown }) => r.error !== undefined,
    );

    if (failingResults.length > 0) {
      // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
      console.error(
        warning(
          `Evaluator ${evaluator.evalName} failed with ${pluralize("error", failingResults.length, true)}. This evaluation ("${evaluator.evalName}") will not be fully logged.`,
        ),
      );
      if (jsonl) {
        for (const result of failingResults) {
          process.stdout.write(JSON.stringify(result));
          process.stdout.write("\n");
        }
      } else if (verbose) {
        for (const result of failingResults) {
          // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
          console.error(result);
        }
      }
    }

    process.stdout.write(
      jsonl ? JSON.stringify(summary) : formatExperimentSummaryFancy(summary),
    );
    process.stdout.write("\n");
    return failingResults.length === 0;
  },
  async reportRun(evalReports: boolean[]) {
    return evalReports.every((r) => r);
  },
};
