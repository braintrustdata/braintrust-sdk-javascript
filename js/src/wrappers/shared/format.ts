import type { ExperimentSummary } from "../../logger/experiments";

export function formatExperimentSummary(summary: ExperimentSummary): string {
  const lines: string[] = [];
  lines.push("\n┌─ Braintrust Experiment Summary ─────────────────┐");
  lines.push(`│ Experiment: ${summary.experimentName}`);

  if (Object.keys(summary.scores).length > 0) {
    lines.push("│");
    lines.push("│ Scores:");
    for (const [name, score] of Object.entries(summary.scores)) {
      const percent = (score.score * 100).toFixed(2);
      lines.push(`│   ${name}: ${percent}%`);
    }
  }

  if (summary.metrics && Object.keys(summary.metrics).length > 0) {
    lines.push("│");
    lines.push("│ Metrics:");
    for (const [name, metric] of Object.entries(summary.metrics)) {
      const value = Number.isInteger(metric.metric)
        ? metric.metric.toFixed(0)
        : metric.metric.toFixed(2);
      const formatted =
        metric.unit === "$"
          ? `${metric.unit}${value}`
          : `${value}${metric.unit}`;
      lines.push(`│   ${name}: ${formatted}`);
    }
  }

  if (summary.experimentUrl) {
    lines.push("│");
    lines.push(`│ View results: ${summary.experimentUrl}`);
  }

  lines.push("└──────────────────────────────────────────────────┘\n");
  return lines.join("\n");
}
