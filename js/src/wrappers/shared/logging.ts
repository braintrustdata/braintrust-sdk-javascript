import { currentSpan, type Span } from "../../logger/core";

export function logOutputs(outputs: Record<string, unknown>): void {
  currentSpan().log({ output: outputs });
}

export function logFeedback(feedback: {
  name: string;
  score: number;
  metadata?: Record<string, unknown>;
}): void {
  currentSpan().log({
    scores: { [feedback.name]: feedback.score },
    metadata: feedback.metadata,
  });
}

export function getCurrentSpan(): Span {
  return currentSpan();
}
