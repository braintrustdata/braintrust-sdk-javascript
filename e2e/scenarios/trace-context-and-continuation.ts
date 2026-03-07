import {
  flush,
  initLogger,
  startSpan,
  traced,
  updateSpan,
  withCurrent,
  withParent,
} from "braintrust";
import { getTestRunId, runMain, scopedName } from "./helpers";

async function main() {
  const testRunId = getTestRunId();
  const logger = initLogger({
    projectName: scopedName("e2e-trace-context-and-continuation", testRunId),
  });

  const rootSpan = logger.startSpan({
    name: "context-root",
    event: {
      metadata: {
        scenario: "trace-context-and-continuation",
        testRunId,
      },
    },
  });
  const exportedRoot = await rootSpan.export();

  await withCurrent(rootSpan, async () => {
    const currentChild = startSpan({
      name: "current-child",
      event: {
        metadata: {
          kind: "current-child",
          testRunId,
        },
      },
    });
    currentChild.log({
      output: {
        source: "withCurrent",
      },
    });
    currentChild.end();
  });

  rootSpan.end();

  await withParent(exportedRoot, async () => {
    await traced(
      (span) => {
        span.log({
          output: {
            resumed: true,
          },
        });
      },
      {
        name: "reattached-child",
        event: {
          metadata: {
            kind: "reattached-child",
            testRunId,
          },
        },
      },
    );
  });

  const updatableSpan = logger.startSpan({
    name: "late-update",
    event: {
      metadata: {
        kind: "late-update",
        testRunId,
      },
    },
  });
  const exportedUpdatableSpan = await updatableSpan.export();
  updatableSpan.end();

  await logger.flush();

  updateSpan({
    exported: exportedUpdatableSpan,
    metadata: {
      kind: "late-update",
      patched: true,
      testRunId,
    },
    output: {
      state: "updated",
    },
  });

  await flush();
}

runMain(main);
