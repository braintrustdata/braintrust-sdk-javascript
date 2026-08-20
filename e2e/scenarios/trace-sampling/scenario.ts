import { initLogger } from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const droppedLogger = initLogger({
    projectName: scopedName("e2e-trace-sampling-dropped", testRunId),
    sampleRate: 0,
  });
  await droppedLogger.traced(
    (root) => {
      root.startSpan({ name: "trace-sampling-dropped-child" }).end();
    },
    { name: "trace-sampling-dropped-root" },
  );
  await droppedLogger.flush();

  const keptLogger = initLogger({
    projectName: scopedName("e2e-trace-sampling-kept", testRunId),
    sampleRate: 0,
  });
  await keptLogger.traced(
    (root) => {
      root
        .startSpan({
          name: "trace-sampling-kept-child",
          event: { metadata: { testRunId } },
        })
        .end();
    },
    {
      name: "trace-sampling-kept-root",
      sampleRate: 1,
      event: { metadata: { testRunId } },
    },
  );
  await keptLogger.flush();
}

runMain(main);
