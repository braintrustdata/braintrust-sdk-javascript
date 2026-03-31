import type { Span } from "../../logger";
import type { Score } from "../../../util/score";
import type { ScorerFunction } from "./types";

export async function runScorers(args: {
  scorers: ScorerFunction[];
  output: unknown;
  expected: unknown;
  input: unknown;
  metadata: Record<string, unknown> | undefined;
  span: Span;
}): Promise<void> {
  const { scorers, output, expected, input, metadata, span } = args;

  const scorerArgs = {
    output,
    expected,
    input,
    metadata: metadata || {},
  };

  await Promise.all(
    scorers.map(async (scorer) => {
      try {
        const result = await scorer(scorerArgs);
        const scores = normalizeScores(result);

        if (scores.length > 0) {
          const accScores: Record<string, number | null> = {};
          let accMetadata: Record<string, unknown> = {};
          for (const score of scores) {
            accScores[score.name] = score.score;
            if (score.metadata && Object.keys(score.metadata).length > 0) {
              accMetadata = { ...accMetadata, ...score.metadata };
            }
          }
          span.log({
            scores: accScores,
            ...(Object.keys(accMetadata).length > 0
              ? { metadata: accMetadata }
              : {}),
          });
        }
      } catch (scorerError) {
        // Log scorer error but don't fail the test — use metadata instead
        // of top-level error field to avoid marking the span as errored
        // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
        console.warn("Braintrust: Scorer failed:", scorerError);
        const errorStr =
          scorerError instanceof Error
            ? `${scorerError.message}\n\n${scorerError.stack || ""}`
            : String(scorerError);
        span.log({ metadata: { scorer_error: errorStr } });
      }
    }),
  );
}

function isScore(val: object): val is Score {
  return "name" in val && "score" in val;
}

function normalizeScores(result: unknown): Score[] {
  if (result === null || result === undefined) {
    return [];
  }

  if (typeof result === "number") {
    return [{ name: "score", score: result }];
  }

  if (Array.isArray(result)) {
    return result.filter(
      (s): s is Score =>
        s !== null && s !== undefined && typeof s === "object" && isScore(s),
    );
  }

  if (typeof result === "object" && result !== null && isScore(result)) {
    return [result];
  }

  return [];
}
