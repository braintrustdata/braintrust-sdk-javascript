import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "@langchain/langgraph-api/server";

// Run the official server in its own process, as a remote deployment would.
// Only the client is instrumented; model traffic still uses the cassette proxy.
const cwd = await mkdtemp(join(tmpdir(), "braintrust-langgraph-server-"));
let server;
async function shutdown() {
  await server?.cleanup();
  await rm(cwd, { recursive: true, force: true });
  // The server's background workers have no shutdown API.
  process.exit(0);
}
process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);

try {
  const graphPath = fileURLToPath(new URL("./graph.mjs", import.meta.url));
  server = await startServer({
    cwd,
    host: "127.0.0.1",
    port: 0,
    nWorkers: 2,
    graphs: {
      agent: `${graphPath}:agent`,
      approval: `${graphPath}:approval`,
      failing: `${graphPath}:failing`,
    },
  });
  process.send({ apiUrl: `http://${server.host}` });
} catch (error) {
  console.error(error);
  await rm(cwd, { recursive: true, force: true });
  process.exit(1);
}
