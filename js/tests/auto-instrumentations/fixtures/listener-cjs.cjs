const { parentPort } = require("worker_threads");
const { getInvocationHook } = require("./global-hook-listener.cjs");

const events = { start: [], end: [], error: [] };
// NOTE: code-transformer prepends "orchestrion:openai:" to the channel name
const expectedChannel = "orchestrion:openai:chat.completions.create";

getInvocationHook(expectedChannel).intercept((target, receiver, args) => {
  events.start.push({ args, self: !!receiver });
  try {
    const result = Reflect.apply(target, receiver, args);
    Promise.resolve(result).then(
      (value) => {
        events.end.push({
          result: value ? JSON.parse(JSON.stringify(value)) : null,
        });
      },
      (error) => {
        events.error.push({ error: String(error) });
      },
    );
    return result;
  } catch (error) {
    events.error.push({ error: String(error) });
    throw error;
  }
});

// Send all accumulated events on exit
process.on("beforeExit", () => {
  parentPort?.postMessage({ type: "events", events });
});
