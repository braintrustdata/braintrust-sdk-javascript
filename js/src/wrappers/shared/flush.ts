import { sdkConsole } from "../../logs/console";
import type { Experiment } from "../../logger/experiments";
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
  if (!shouldDisplay) {
    await experiment.flush();
    return;
  }

  const summary = await experiment.summarize();
  sdkConsole.log(formatExperimentSummary(summary));
}
