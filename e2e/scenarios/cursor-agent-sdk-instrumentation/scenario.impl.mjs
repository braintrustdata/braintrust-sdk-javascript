import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTracedScenario } from "../../helpers/provider-runtime.mjs";

export const SCENARIO_NAME = "cursor-agent-sdk-instrumentation";
export const ROOT_NAME = "cursor-agent-sdk-root";

const scenarioDir = path.dirname(fileURLToPath(import.meta.url));

export async function runCursorAgentSDKInstrumentation() {
  const packageName =
    process.env.AGENT_SDK_PACKAGE_NAME ?? "agent-sdk-v0-latest";
  await linkAgentSdk(packageName);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "cursor-agent-workspace-"),
  );
  const stateRoot = await mkdtemp(path.join(tmpdir(), "cursor-agent-state-"));
  process.env.CURSOR_AGENT_WORKSPACE = workspace;
  const { serve } = await import("@grok/agent-sdk");
  let server;
  try {
    await runTracedScenario({
      metadata: { scenario: SCENARIO_NAME },
      projectNameBase: "cursor-agent-sdk-instrumentation",
      rootName: ROOT_NAME,
      callback: async () => {
        server = await serve(scenarioDir, {
          apiKey: process.env.CURSOR_API_KEY,
          dev: true,
          docs: false,
          host: "127.0.0.1",
          mode: "single",
          playground: false,
          port: 0,
          reminders: false,
          schedules: false,
          stateRoot,
        });
        await exercise(server.url);
      },
    });
  } finally {
    await server?.close();
    await rm(workspace, { force: true, recursive: true });
    await rm(stateRoot, { force: true, recursive: true });
  }
}

async function linkAgentSdk(packageName) {
  const scoped = path.join(scenarioDir, "node_modules", "@grok");
  await mkdir(scoped, { recursive: true });
  const link = path.join(scoped, "agent-sdk");
  await rm(link, { force: true, recursive: true });
  await symlink(path.join(scenarioDir, "node_modules", packageName), link);
}

async function exercise(base) {
  const stamp = await runTurn(base, { message: "STAMP: BRAINTRUST_STAMP_OK" });
  requireText(stamp.events, "BRAINTRUST_STAMP_OK", "stamp");
  const followUp = await runTurn(
    base,
    {
      message:
        "Do not call any tool. Reply with exactly FOLLOWUP_OK and no other text.",
    },
    stamp,
  );
  requireText(followUp.events, "FOLLOWUP_OK", "follow-up");
  const subagent = await runTurn(base, { message: "DELEGATE" });
  requireText(subagent.events, "SUBAGENT_OK", "subagent");
  const failure = await runTurn(base, { message: "FAIL" });
  requireText(failure.events, "fail_tool exploded", "failure");
  const longTool = await runTurn(base, { message: "LONG" });
  requireText(longTool.events, "LONG_MARKER", "long tool");
  const cancelled = await cancelTurn(base, "HANG");
  requireCancelled(cancelled.events);
  // Start session B once session A's model stream is open. The two turns
  // still overlap, and their streams start in a fixed order, which replay
  // needs because stream requests are matched in call order.
  const beforeA = await listSessionIds(base);
  const pendingA = runTurn(base, { message: "STAMP: SESSION_A" });
  const sessionAId = await waitForNewSession(base, beforeA, pendingA);
  await waitForToolRequest(base, sessionAId, "stamp");
  const [sessionA, sessionB] = await Promise.all([
    pendingA,
    runTurn(base, { message: "STAMP: SESSION_B" }),
  ]);
  if (sessionA.sessionId === sessionB.sessionId) {
    throw new Error("Concurrent sessions reused one session id");
  }
  requireText(sessionA.events, "SESSION_A", "session A");
  requireText(sessionB.events, "SESSION_B", "session B");
}

async function runTurn(base, turn, previous) {
  const response = await fetch(
    previous
      ? `${base}/v1/session/${previous.sessionId}`
      : `${base}/v1/session`,
    {
      body: JSON.stringify({
        ...(previous ? { continuationToken: previous.continuationToken } : {}),
        message: turn.message,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `${turn.message} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return {
    ...body,
    events: await readEvents(
      base,
      body.sessionId,
      previous?.events?.at(-1)?.index ?? -1,
    ),
  };
}

async function cancelTurn(base, message) {
  const before = await listSessionIds(base);
  const pending = fetch(`${base}/v1/session`, {
    body: JSON.stringify({ message }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then(async (response) => ({
    body: await response.json(),
    response,
  }));
  const sessionId = await waitForNewSession(base, before, pending);
  await waitForToolRequest(base, sessionId, "hang");
  const stop = await fetch(`${base}/v1/session/${sessionId}/stop`, {
    method: "POST",
  });
  if (!stop.ok && stop.status !== 409) {
    throw new Error(`stop failed (${stop.status})`);
  }
  const started = await pending;
  if (!started.response.ok) {
    throw new Error(
      `hang session failed (${started.response.status}): ${JSON.stringify(started.body)}`,
    );
  }
  return {
    ...started.body,
    events: await readEvents(base, sessionId),
    sessionId,
  };
}

async function listSessionIds(base) {
  const response = await fetch(`${base}/v1/sessions`);
  if (!response.ok) {
    return [];
  }
  const body = await response.json();
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  return sessions
    .map((session) => session.id ?? session.sessionId)
    .filter((id) => typeof id === "string");
}

async function waitForNewSession(base, before, pending) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ids = await listSessionIds(base);
    const created = ids.find((id) => !before.includes(id));
    if (created) {
      return created;
    }
    const settled = await Promise.race([
      pending.then((value) => value),
      delay(250).then(() => undefined),
    ]);
    const settledId = settled?.body?.sessionId ?? settled?.sessionId;
    if (settledId) {
      return settledId;
    }
    if (settled !== undefined) {
      await delay(250);
    }
  }
  throw new Error("Timed out before the new session was created");
}

async function waitForToolRequest(base, sessionId, toolName) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${base}/v1/session/${sessionId}/events?format=json`,
    );
    if (response.ok) {
      const body = await response.json();
      const events = Array.isArray(body.events) ? body.events : [];
      const serialized = events
        .filter(
          (event) =>
            event?.type === "actions.requested" ||
            event?.type === "action.result",
        )
        .map((event) => JSON.stringify(event.data ?? {}))
        .join("\n");
      if (serialized.includes(toolName)) {
        return;
      }
      if (
        events.some(
          (event) =>
            event?.type === "turn.completed" || event?.type === "turn.failed",
        )
      ) {
        return;
      }
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${toolName} in session ${sessionId}`);
}

async function readEvents(base, sessionId, afterIndex = -1) {
  const deadline = Date.now() + 180_000;
  let lastTypes = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${base}/v1/session/${sessionId}/events?format=json`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (response.ok) {
        const body = await response.json();
        const events = Array.isArray(body.events) ? body.events : [];
        lastTypes = events
          .map((event) => event?.type)
          .filter(Boolean)
          .slice(-8);
        if (
          events.some(
            (event) =>
              (event?.type === "turn.completed" ||
                event?.type === "turn.failed") &&
              (event.index ?? 0) > afterIndex,
          )
        ) {
          return events;
        }
      } else {
        lastTypes = [`http ${response.status}`];
      }
    } catch (error) {
      if (error?.name !== "TimeoutError" && error?.name !== "AbortError") {
        throw error;
      }
      lastTypes = ["events request timed out"];
    }
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for session ${sessionId} after index ${afterIndex}. Last events: ${lastTypes.join(", ") || "none"}`,
  );
}

function requireText(events, text, label) {
  const produced = events
    .filter((event) => event?.type !== "message.received")
    .map((event) => JSON.stringify(event.data ?? ""))
    .join("\n");
  if (!produced.includes(text)) {
    const types = events.map((event) => event?.type).slice(-8);
    throw new Error(
      `${label} did not produce ${text}. Last events: ${types.join(", ")}`,
    );
  }
}

function requireCancelled(events) {
  const failed = [...events]
    .reverse()
    .find((event) => event?.type === "turn.failed");
  if (!failed || failed.data?.status !== "cancelled") {
    const last = [...events]
      .reverse()
      .find(
        (event) =>
          event?.type === "turn.completed" || event?.type === "turn.failed",
      );
    throw new Error(
      `Hang turn did not finish as cancelled: ${JSON.stringify(last ?? null)}`,
    );
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
