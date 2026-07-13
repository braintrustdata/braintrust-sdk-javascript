import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { runMain } from "../../helpers/scenario-runtime";

async function main() {
  const eveBin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "eve.cmd" : "eve",
  );

  await runProcess(eveBin, ["build"], 90_000);

  const port = await getFreePort();
  const server = spawn(
    eveBin,
    ["start", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = captureOutput(server);

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForEve(baseUrl, server, output);

    const response = await fetch(`${baseUrl}/eve/v1/session`, {
      body: JSON.stringify({
        message: "Run the Braintrust Eve instrumentation e2e scenario",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Eve session create failed with ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as {
      continuationToken?: string;
      sessionId?: string;
    };
    if (!body.sessionId || !body.continuationToken) {
      throw new Error(
        `Eve session create did not return a sessionId and continuationToken`,
      );
    }

    const seenSessionIds = new Set([body.sessionId]);
    const nextIndex = await streamUntil(
      baseUrl,
      body.sessionId,
      seenSessionIds,
      "session.waiting",
    );
    const followUp = await fetch(
      `${baseUrl}/eve/v1/session/${body.sessionId}`,
      {
        body: JSON.stringify({
          continuationToken: body.continuationToken,
          message: "Run the Braintrust Eve instrumentation e2e scenario again",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    if (!followUp.ok) {
      throw new Error(
        `Eve session follow-up failed with ${followUp.status}: ${await followUp.text()}`,
      );
    }

    await streamUntil(
      baseUrl,
      body.sessionId,
      seenSessionIds,
      "session.waiting",
      nextIndex,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } finally {
    await stopServer(server);
  }
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a port for eve");
  }
  return address.port;
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = captureOutput(child);
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  try {
    const [code] = (await once(child, "close")) as [number | null];
    if (code !== 0) {
      throw new Error(
        `${path.basename(command)} ${args.join(" ")} failed with code ${code}\n${output()}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function captureOutput(child: ChildProcessWithoutNullStreams): () => string {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return () => `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
}

async function waitForEve(
  baseUrl: string,
  server: ChildProcessWithoutNullStreams,
  output: () => string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    if (server.exitCode !== null) {
      throw new Error(
        `eve start exited early with code ${server.exitCode}\n${output()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/eve/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the server starts accepting connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for eve start\n${output()}`);
}

async function streamUntil(
  baseUrl: string,
  sessionId: string,
  seenSessionIds: Set<string>,
  until: "session.waiting" | "turn.completed",
  startIndex = 0,
): Promise<number> {
  const controller = new AbortController();
  const childStreams: Promise<void>[] = [];
  const response = await fetch(
    `${baseUrl}/eve/v1/session/${sessionId}/stream?startIndex=${startIndex}`,
    {
      signal: controller.signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(
      `Eve stream failed with ${response.status}: ${await response.text()}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextIndex = startIndex;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`Eve stream ended before ${until}`);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const event = JSON.parse(trimmed) as {
          data?: { childSessionId?: string; message?: string };
          type?: string;
        };
        nextIndex++;
        if (
          event.type === "step.failed" ||
          event.type === "turn.failed" ||
          event.type === "session.failed"
        ) {
          throw new Error(
            `Eve emitted ${event.type}: ${event.data?.message ?? trimmed}`,
          );
        }
        if (
          event.type === "subagent.called" &&
          typeof event.data?.childSessionId === "string" &&
          !seenSessionIds.has(event.data.childSessionId)
        ) {
          seenSessionIds.add(event.data.childSessionId);
          childStreams.push(
            streamUntil(
              baseUrl,
              event.data.childSessionId,
              seenSessionIds,
              "turn.completed",
            ).then(() => undefined),
          );
        }
        if (event.type === until) {
          await Promise.all(childStreams);
          return nextIndex;
        }
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

async function stopServer(
  server: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (server.exitCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  const timeout = setTimeout(() => server.kill("SIGKILL"), 5_000);
  try {
    await once(server, "close");
  } finally {
    clearTimeout(timeout);
  }
}

runMain(main);
