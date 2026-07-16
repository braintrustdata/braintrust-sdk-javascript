import { spawn as spawnChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { Readable } from "node:stream";

export async function createDockerSandbox() {
  const containerName = `braintrust-harness-codex-${process.pid}`;
  const containerPort = 4000;
  const hostPort = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
  const children = new Set();
  const loopbackForwarders = new Map();
  let containerStarted = false;
  let session;

  async function docker(args, options = {}) {
    const child = spawnChildProcess("docker", args, {
      stdio: [options.input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.input != null) child.stdin.end(options.input);
    const [stdout, stderr, result] = await Promise.all([
      new Response(Readable.toWeb(child.stdout)).text(),
      new Response(Readable.toWeb(child.stderr)).text(),
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) =>
          resolve({ exitCode: exitCode ?? 1, signal }),
        );
      }),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `docker ${args[0]} failed with exit code ${result.exitCode}: ${stderr}`,
      );
    }
    return { ...result, stdout, stderr };
  }

  async function forwardLoopbackPort(targetPort) {
    const existing = loopbackForwarders.get(targetPort);
    if (existing != null) return existing.port;

    const sockets = new Set();
    const server = createServer((socket) => {
      const target = connect(targetPort, "127.0.0.1");
      sockets.add(socket);
      sockets.add(target);
      socket.pipe(target).pipe(socket);
      socket.on("close", () => sockets.delete(socket));
      target.on("close", () => sockets.delete(target));
      socket.on("error", () => target.destroy());
      target.on("error", () => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (address == null || typeof address === "string") {
      server.close();
      throw new Error("Could not create a Docker-to-host port forwarder.");
    }
    const forwarder = { port: address.port, server, sockets };
    loopbackForwarders.set(targetPort, forwarder);
    return forwarder.port;
  }

  async function ensureContainer() {
    if (containerStarted) return;
    await docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--publish",
      `127.0.0.1:${hostPort}:${containerPort}`,
      "node:24-bookworm",
      "sleep",
      "infinity",
    ]);
    containerStarted = true;
    await docker([
      "exec",
      containerName,
      "/bin/sh",
      "-lc",
      "corepack enable pnpm && corepack install --global pnpm@10.33.0 && mkdir -p /workspace /root/.codex",
    ]);
  }

  async function spawn({
    command,
    workingDirectory = "/workspace",
    env,
    abortSignal,
  }) {
    const envArgs = [];
    for (const [key, value] of Object.entries(env ?? {})) {
      let serializedValue = String(value);
      try {
        const url = new URL(serializedValue);
        if (url.hostname === "127.0.0.1" && url.port !== "") {
          url.hostname = "host.docker.internal";
          url.port = String(await forwardLoopbackPort(Number(url.port)));
          serializedValue = url.toString();
        }
      } catch {
        // Non-URL environment values do not need Docker host rewriting.
      }
      envArgs.push("--env", `${key}=${serializedValue}`);
    }
    const child = spawnChildProcess(
      "docker",
      [
        "exec",
        ...envArgs,
        "--workdir",
        workingDirectory,
        containerName,
        "/bin/sh",
        "-lc",
        command,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.add(child);
    const wait = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        children.delete(child);
        resolve({ exitCode: exitCode ?? 1, signal });
      });
    });
    const abort = () => child.kill("SIGTERM");
    abortSignal?.addEventListener("abort", abort, { once: true });
    void wait.finally(() => abortSignal?.removeEventListener("abort", abort));
    return {
      stdout: Readable.toWeb(child.stdout),
      stderr: Readable.toWeb(child.stderr),
      wait: () => wait,
      async kill() {
        child.kill("SIGTERM");
        await wait.catch(() => {});
      },
    };
  }

  async function run(options) {
    const child = await spawn(options);
    const [stdout, stderr, result] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.wait(),
    ]);
    return { ...result, stdout, stderr };
  }

  return {
    provider: {
      specificationVersion: "harness-sandbox-v1",
      providerId: "docker-codex-e2e",
      async createSession({ sessionId }) {
        await ensureContainer();
        if (session != null) return session;
        const restricted = {
          description: "Docker sandbox for the Codex harness e2e test.",
          async readTextFile({ path }) {
            const result = await run({
              command: `cat -- ${JSON.stringify(path)}`,
            });
            return result.exitCode === 0 ? result.stdout : null;
          },
          async writeTextFile({ path, content }) {
            await docker(
              [
                "exec",
                "--interactive",
                containerName,
                "/bin/sh",
                "-c",
                'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
                "sh",
                path,
              ],
              { input: content },
            );
          },
          spawn,
          run,
        };
        session = {
          ...restricted,
          id: sessionId,
          defaultWorkingDirectory: "/workspace",
          ports: [containerPort],
          async getPortUrl({ port, protocol = "http" }) {
            if (port !== containerPort) {
              throw new Error(`Docker sandbox does not expose port ${port}.`);
            }
            return `${protocol}://127.0.0.1:${hostPort}`;
          },
          restricted() {
            return restricted;
          },
          async stop() {},
          async destroy() {},
        };
        return session;
      },
      async resumeSession() {
        if (session == null) {
          throw new Error("Docker sandbox session was not found.");
        }
        return session;
      },
    },
    async destroy() {
      for (const child of children) child.kill("SIGTERM");
      if (containerStarted) {
        await docker(["rm", "--force", containerName]).catch(() => {});
      }
      for (const { server, sockets } of loopbackForwarders.values()) {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
