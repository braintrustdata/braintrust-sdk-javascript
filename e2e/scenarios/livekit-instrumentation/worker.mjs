import { Worker } from "node:worker_threads";
const worker = new Worker(new URL("./scenario.mjs", import.meta.url));
await new Promise((resolve, reject) => {
  worker.on("error", reject);
  worker.on("exit", (code) =>
    code ? reject(new Error(`Worker exited ${code}`)) : resolve(),
  );
});
