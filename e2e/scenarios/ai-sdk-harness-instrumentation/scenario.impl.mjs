import { initLogger } from "braintrust";
import { createDockerSandbox } from "./docker-sandbox.mjs";

const SESSION_ID = "shared-harness-session";
const TURN_SPAN_INFO = {
  metadata: {
    scenario: "ai-sdk-harness-instrumentation",
    testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
  },
};

async function waitForFile(session, filePath) {
  const sandbox = session.getSandboxSession().restricted();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await sandbox.run({
      command: `test -f ${JSON.stringify(filePath)}`,
    });
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Codex did not create ${filePath} in time.`);
}

export async function runHarnessAgentScenario(HarnessAgent) {
  const codexPackageName =
    process.env.AI_SDK_HARNESS_CODEX_PACKAGE_NAME ?? "ai-sdk-harness-codex-v1";
  const { createCodex } = await import(codexPackageName);
  const dockerSandbox = await createDockerSandbox();
  const logger = initLogger({
    projectName:
      process.env.BRAINTRUST_E2E_PROJECT_NAME ??
      "e2e-ai-sdk-harness-instrumentation",
  });
  const agent = new HarnessAgent({
    harness: createCodex({
      model: process.env.AI_SDK_HARNESS_CODEX_E2E_MODEL ?? "gpt-5.4-mini",
      reasoningEffort: "low",
      webSearch: false,
    }),
    permissionMode: "allow-all",
    sandbox: dockerSandbox.provider,
  });
  try {
    let session = await agent.createSession({ sessionId: SESSION_ID });
    const generated = agent.generate({
      prompt:
        'Run the built-in bash command "touch /workspace/generate-started; sleep 5; printf GENERATE_OK" exactly once. After it finishes, reply exactly GENERATE_OK.',
      session,
      span_info: TURN_SPAN_INFO,
    });
    await waitForFile(session, "/workspace/generate-started");
    const generateContinuationState = await session.suspendTurn();
    await generated;

    session = await agent.createSession({
      sessionId: SESSION_ID,
      continueFrom: generateContinuationState,
    });
    await agent.continueGenerate({
      session,
      span_info: TURN_SPAN_INFO,
      toolApprovalContinuations: [],
    });
    await session.destroy();

    session = await agent.createSession({ sessionId: SESSION_ID });
    const streamed = await agent.stream({
      messages: [
        {
          role: "user",
          content:
            'Run the built-in bash command "touch /workspace/stream-started; sleep 5; printf STREAM_OK" exactly once. After it finishes, reply exactly STREAM_OK.',
        },
      ],
      session,
      span_info: TURN_SPAN_INFO,
    });
    const streamDrain = (async () => {
      for await (const _part of streamed.fullStream) {
        // Drain until the session is suspended below.
      }
    })();
    await waitForFile(session, "/workspace/stream-started");
    const streamContinuationState = await session.suspendTurn();
    await streamDrain;

    session = await agent.createSession({
      sessionId: SESSION_ID,
      continueFrom: streamContinuationState,
    });
    const continuedStream = await agent.continueStream({
      session,
      span_info: TURN_SPAN_INFO,
      toolApprovalContinuations: [],
    });
    for await (const _part of continuedStream.fullStream) {
      // Drain the real Codex turn so usage and the root span are finalized.
    }
    await session.destroy();
    await logger.flush();
  } finally {
    await dockerSandbox.destroy();
  }
}
