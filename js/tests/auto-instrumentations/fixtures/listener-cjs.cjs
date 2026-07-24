const { parentPort } = require("worker_threads");
const { getTracingHook } = require("./global-hook-listener.cjs");

const events = { start: [], end: [], error: [] };
// NOTE: code-transformer prepends "orchestrion:openai:" to the channel name
const expectedChannel = "orchestrion:openai:chat.completions.create";

// Subscribe to the global hook and accumulate events
const channel = getTracingHook(expectedChannel);
channel.subscribe({
  start: (ctx) => {
    // Convert arguments to array for serialization
    events.start.push({
      args: Array.from(ctx.arguments || []),
      self: !!ctx.self,
    });
  },
  end: (ctx) => {
    // Only send serializable result data
    events.end.push({
      result: ctx.result ? JSON.parse(JSON.stringify(ctx.result)) : null,
    });
  },
  error: (ctx) => {
    events.error.push({ error: String(ctx.error) });
  },
});

// Send all accumulated events on exit
process.on("beforeExit", () => {
  parentPort?.postMessage({ type: "events", events });
});
