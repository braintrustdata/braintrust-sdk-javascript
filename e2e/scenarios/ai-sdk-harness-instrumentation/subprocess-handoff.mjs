import { readFile, writeFile } from "node:fs/promises";
import { initLogger, wrapAgentClass } from "braintrust";

const HANDOFF_PATH = process.env.BRAINTRUST_HARNESS_HANDOFF_PATH;
const PHASE = process.env.BRAINTRUST_HARNESS_HANDOFF_PHASE;
const SESSION_ID = "subprocess-handoff-session";
const TURN_SPAN_INFO = {
  metadata: {
    scenario: "ai-sdk-harness-subprocess-handoff",
    testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
  },
};

if (!HANDOFF_PATH) {
  throw new Error("BRAINTRUST_HARNESS_HANDOFF_PATH is required.");
}
if (PHASE !== "suspend" && PHASE !== "resume") {
  throw new Error(
    "BRAINTRUST_HARNESS_HANDOFF_PHASE must be suspend or resume.",
  );
}

class HarnessSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.suspended = new Promise((resolve) => {
      this.resolveSuspended = resolve;
    });
  }

  async suspendTurn() {
    this.resolveSuspended();
    return {
      data: { cursor: 1 },
      harnessId: "subprocess-handoff",
      specificationVersion: "harness-v1",
      type: "continue-turn",
    };
  }
}

class HarnessAgent {
  harnessId = "subprocess-handoff";
  permissionMode = "allow-all";
  settings = {};
  tools = {};

  async createSession({ sessionId = SESSION_ID } = {}) {
    return new HarnessSession(sessionId);
  }

  async generate({ session }) {
    await session.suspended;
    return {
      text: "suspended output",
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      },
    };
  }

  async continueGenerate() {
    return {
      text: "resumed output",
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      },
    };
  }
}

const logger = initLogger({
  projectName:
    process.env.BRAINTRUST_E2E_PROJECT_NAME ??
    "e2e-ai-sdk-harness-instrumentation",
});
const WrappedHarnessAgent = wrapAgentClass(HarnessAgent);
const agent = new WrappedHarnessAgent();

if (PHASE === "suspend") {
  const session = await agent.createSession({ sessionId: SESSION_ID });
  const generated = agent.generate({
    prompt: "Start a turn that will resume in another process.",
    session,
    span_info: TURN_SPAN_INFO,
  });
  const continuation = await session.suspendTurn();
  await generated;
  await writeFile(
    HANDOFF_PATH,
    JSON.stringify({ continuation, producerPid: process.pid }),
    "utf8",
  );
} else {
  const handoff = JSON.parse(await readFile(HANDOFF_PATH, "utf8"));
  const session = await agent.createSession({
    continueFrom: handoff.continuation,
    sessionId: SESSION_ID,
  });
  await agent.continueGenerate({
    session,
    span_info: TURN_SPAN_INFO,
    toolApprovalContinuations: [],
  });
  process.stdout.write(
    JSON.stringify({
      producerPid: handoff.producerPid,
      resumerPid: process.pid,
    }),
  );
}

await logger.flush();
