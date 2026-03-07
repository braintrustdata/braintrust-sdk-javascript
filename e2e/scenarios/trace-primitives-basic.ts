import { initLogger, logError, startSpan } from "braintrust";
import { getTestRunId, runMain, scopedName } from "./helpers";

async function main() {
  const testRunId = getTestRunId();
  const logger = initLogger({
    projectName: scopedName("e2e-trace-primitives-basic", testRunId),
  });

  await logger.traced(
    async (rootSpan) => {
      const childSpan = startSpan({
        name: "basic-child",
        event: {
          input: {
            step: "child",
            testRunId,
          },
          metadata: {
            kind: "basic-child",
            testRunId,
          },
        },
      });
      childSpan.log({
        output: {
          ok: true,
        },
      });
      childSpan.end();

      const errorSpan = startSpan({
        name: "basic-error",
        event: {
          metadata: {
            kind: "basic-error",
            testRunId,
          },
        },
      });
      logError(errorSpan, new Error("basic boom"));
      errorSpan.end();

      rootSpan.log({
        output: {
          status: "ok",
        },
      });
    },
    {
      name: "trace-primitives-root",
      event: {
        input: {
          scenario: "trace-primitives-basic",
          testRunId,
        },
        metadata: {
          scenario: "trace-primitives-basic",
          testRunId,
        },
      },
    },
  );

  await logger.flush();
}

runMain(main);
