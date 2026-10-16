import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";
const env = { ...process.env, LIVEKIT_AUTO_MODE: "off" };
const entry = new URL("./automatic.mjs", import.meta.url);
const worker =
  process.env.LIVEKIT_AUTO_MODE === "fork"
    ? fork(entry, [], { env })
    : new Worker(entry, { env });
await new Promise((resolve, reject) => {
  worker.on("error", reject);
  worker.on("exit", (code) =>
    code ? reject(new Error(`Worker exited ${code}`)) : resolve(),
  );
});
