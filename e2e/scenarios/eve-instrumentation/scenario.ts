import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { initLogger, traced } from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const tscBin = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  await runProcess(
    process.execPath,
    [tscBin, "--project", path.join(process.cwd(), "tsconfig.typecheck.json")],
    90_000,
  );

  const evePackageName = process.env.EVE_PACKAGE_NAME ?? "eve-v0-latest";
  const evePackageDir = path.join(
    process.cwd(),
    "node_modules",
    evePackageName,
  );
  const evePackage = JSON.parse(
    await readFile(path.join(evePackageDir, "package.json"), "utf8"),
  ) as { bin?: string | Record<string, string>; version: string };
  process.env.EVE_VERSION = evePackage.version;
  const eveBinPath =
    typeof evePackage.bin === "string" ? evePackage.bin : evePackage.bin?.eve;
  if (!eveBinPath) {
    throw new Error(`${evePackageName} does not expose an eve CLI`);
  }

  const eveModuleDir = path.join(process.cwd(), "node_modules", "eve");
  try {
    await unlink(eveModuleDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await symlink(evePackageDir, eveModuleDir, "dir");

  // Variants share this directory. Discard the previous variant's active local
  // Workflow runs so `eve start` does not re-enqueue them on startup.
  await rm(path.join(process.cwd(), ".eve", ".workflow-data"), {
    force: true,
    recursive: true,
  });

  const agentDir = path.join(process.cwd(), "agent");
  await rm(path.join(agentDir, "instrumentation.ts"), { force: true });
  await rm(path.join(agentDir, "instrumentation"), {
    force: true,
    recursive: true,
  });
  await rm(path.join(agentDir, "channels", "eve.ts"), { force: true });
  // Eve 0.62 made instrumentation providers stable and rejects the flag.
  const [major = 0, minor = 0] = evePackage.version.split(".").map(Number);
  if (major === 0 && minor < 62) {
    process.env.EVE_EXPERIMENTAL_INSTRUMENTATION_PROVIDERS = "1";
  }
  await mkdir(path.join(agentDir, "instrumentation"), { recursive: true });
  await mkdir(path.join(agentDir, "channels"), { recursive: true });
  await copyFile(
    path.join(process.cwd(), "config", "provider-instrumentation.ts"),
    path.join(agentDir, "instrumentation", "braintrust.ts"),
  );
  await copyFile(
    path.join(process.cwd(), "config", "provider-eve-channel.ts"),
    path.join(agentDir, "channels", "eve.ts"),
  );

  const eveBin = path.join(evePackageDir, eveBinPath);

  await runProcess(process.execPath, [eveBin, "build"], 90_000);

  const port = await getFreePort();
  const server = spawn(
    process.execPath,
    [eveBin, "start", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      // Eve 1.x starts the application in a child process. Stop both together.
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        // The callback receiver is local. Eve 0.91 requires explicit dev mode
        // before accepting loopback callback URLs.
        ...(Number(process.env.EVE_VERSION?.split(".")[0]) >= 1 ||
        Number(process.env.EVE_VERSION?.split(".")[1]) >= 91
          ? { EVE_DEV: "1" }
          : {}),
      },
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
    if (!body.sessionId) {
      throw new Error(`Eve session create did not return a sessionId`);
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
          ...(body.continuationToken
            ? { continuationToken: body.continuationToken }
            : {}),
          message: "Run the Braintrust Eve instrumentation e2e scenario again",
          // Queue the follow-up if the waiting event arrives while Eve is still
          // committing the completed turn's model history.
          turnPolicy: "queue",
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
    if (process.env.EVE_INSTRUMENTATION_PROVIDER === "1") {
      await runTracedCallerSession(baseUrl);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (error) {
    console.error(output());
    throw error;
  } finally {
    await stopServer(server);
  }
}

// Eve only adopts an inbound `traceparent` for session creates that carry a
// callback, so the caller registers a loopback callback receiver.
async function runTracedCallerSession(baseUrl: string): Promise<void> {
  const logger = initLogger({
    projectName: scopedName("e2e-eve-instrumentation"),
  });
  const callbacks = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    callbacks.once("error", reject);
    callbacks.listen(0, "127.0.0.1", () => resolve());
  });
  const address = callbacks.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a port for the Eve callback receiver");
  }
  const token = randomUUID();

  try {
    await traced(
      async (span) => {
        const response = await fetch(`${baseUrl}/eve/v1/session`, {
          body: JSON.stringify({
            ...(Number(process.env.EVE_VERSION?.split(".")[0]) >= 1 ||
            Number(process.env.EVE_VERSION?.split(".")[1]) >= 91
              ? { protocolVersion: 3 }
              : {}),
            callback: {
              callId: "call-traced-caller",
              subagentName: "traced-caller",
              token,
              url: `http://127.0.0.1:${address.port}/eve/v1/callback/${token}`,
            },
            message:
              "Run the Braintrust Eve instrumentation e2e scenario from a traced caller",
          }),
          headers: span.inject({ "content-type": "application/json" }),
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(
            `Traced Eve session create failed with ${response.status}: ${await response.text()}`,
          );
        }
        const body = (await response.json()) as { sessionId?: string };
        if (!body.sessionId) {
          throw new Error(
            `Traced Eve session create did not return a sessionId`,
          );
        }
        await streamUntil(
          baseUrl,
          body.sessionId,
          new Set([body.sessionId]),
          "turn.completed",
        );
      },
      {
        event: {
          metadata: {
            scenario: "eve-instrumentation",
            testRunId: getTestRunId(),
          },
        },
        name: "eve.caller",
      },
    );
    await logger.flush();
  } finally {
    await new Promise<void>((resolve) => callbacks.close(() => resolve()));
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
        type StreamEvent = {
          data?: {
            childSessionId?: string;
            sessionId?: string;
            message?: string;
            outcome?: string;
            error?: { message?: string };
          };
          type?: string;
        };
        const record = JSON.parse(trimmed) as StreamEvent & {
          facts?: StreamEvent[];
          $eve?: string;
          next?: number;
        };
        if (record.$eve) {
          if (record.$eve === "position" && record.next !== undefined) {
            nextIndex = record.next;
          }
          continue;
        }
        nextIndex++;
        // Eve 0.91 streams commits containing multiple session facts.
        for (const event of record.facts ?? [record]) {
          if (
            event.type === "step.failed" ||
            event.type === "turn.failed" ||
            event.type === "session.failed" ||
            ((event.type === "turn.settled" ||
              event.type === "session.ended") &&
              event.data?.outcome === "failed")
          ) {
            throw new Error(
              `Eve emitted ${event.type}: ${event.data?.error?.message ?? event.data?.message ?? trimmed}`,
            );
          }
          const childSessionId =
            event.type === "child.opened"
              ? event.data?.sessionId
              : event.type === "subagent.called"
                ? event.data?.childSessionId
                : undefined;
          if (childSessionId && !seenSessionIds.has(childSessionId)) {
            seenSessionIds.add(childSessionId);
            childStreams.push(
              streamUntil(
                baseUrl,
                childSessionId,
                seenSessionIds,
                "turn.completed",
              ).then(() => undefined),
            );
          }
          if (event.type === until || event.type === "turn.settled") {
            await Promise.all(childStreams);
            return nextIndex;
          }
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
  try {
    if (process.platform !== "win32" && server.pid) {
      process.kill(-server.pid, "SIGTERM");
    } else {
      server.kill("SIGTERM");
    }
  } catch {
    // The server may have exited before receiving the signal.
  }
  const timeout = setTimeout(() => {
    try {
      if (process.platform !== "win32" && server.pid) {
        process.kill(-server.pid, "SIGKILL");
      } else {
        server.kill("SIGKILL");
      }
    } catch {
      // The process group may have exited before forced shutdown.
    }
  }, 5_000);
  try {
    await once(server, "close");
  } finally {
    clearTimeout(timeout);
  }
}

runMain(main);
