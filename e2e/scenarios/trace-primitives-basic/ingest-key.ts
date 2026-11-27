import assert from "node:assert/strict";
import {
  Attachment,
  BraintrustState,
  extractTraceContextFromHeaders,
  initLogger,
  updateSpan,
} from "braintrust";
import { getTestRunId, runMain } from "../../helpers/scenario-runtime";

async function main() {
  const testRunId = getTestRunId();
  const url = new URL("/logs3", process.env.BRAINTRUST_API_URL);
  url.username = "bt-ik-e2e-test";
  const errors: unknown[] = [];
  const state = new BraintrustState({
    apiKey: url.toString(),
    noExitFlush: true,
    onFlushError: (error) => errors.push(error),
  });
  const logger = initLogger({
    state,
    projectName: "ignored-project",
    projectId: "ignored-project-id",
    autoCaptureAttachments: true,
  });
  assert.equal(await logger.id, undefined);
  assert.equal(await logger.project, undefined);
  assert.equal(await logger.org_id, undefined);
  const root = logger.startSpan({
    name: "ingest-key-root",
    event: {
      input: { testRunId },
      metadata: {
        testRunId,
        scenario: "trace-primitives-basic",
        variant: "ingest-key",
      },
    },
  });
  const child = root.startSpan({
    name: "ingest-key-child",
    event: {
      input: {
        testRunId,
        attachment: new Attachment({
          data: new Blob(["test data"]),
          filename: "test.txt",
          contentType: "text/plain",
          state,
        }),
      },
    },
  });
  child.end();
  const exported = await root.export();
  root.end();
  await logger.flush();
  assert.equal(await root.export(), exported);

  const receiverState = new BraintrustState({
    apiKey: url.toString(),
    noExitFlush: true,
    onFlushError: (error) => errors.push(error),
  });
  const receiver = initLogger({ state: receiverState, setCurrent: false });
  const remote = receiver.startSpan({
    name: "ingest-key-remote",
    parent: extractTraceContextFromHeaders(root.inject()),
    event: { input: { testRunId } },
  });
  assert.equal(remote.rootSpanId, root.rootSpanId);
  remote.end();
  updateSpan({ state: receiverState, exported, output: "updated remotely" });
  await receiver.flush();
  assert.deepEqual(errors, []);
}

runMain(main);
