import { captureLiveKitTrace, flush } from "braintrust";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const outcome = JSON.parse(input);
captureLiveKitTrace(outcome);
// Delivering the same outcome twice must update the original span in place.
captureLiveKitTrace(outcome);
await flush();
