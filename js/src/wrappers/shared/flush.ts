import type { Experiment } from "../../logger";
import { formatExperimentSummary } from "./format";

/**
 * Summarize and flush an experiment.
 *
 * `summarize()` calls `flush()` internally
 */
export async function summarizeAndFlush(
  experiment: Experiment,
  options: { displaySummary?: boolean },
): Promise<void> {
  const shouldDisplay = options.displaySummary ?? true;
  const summary = await experiment.summarize();
  if (shouldDisplay) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.log(formatExperimentSummary(summary));
  }
}
