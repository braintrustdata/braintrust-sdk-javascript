// @ts-check
/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    // OpenAI generates the tool-call id and Strands echoes it into the next
    // request. It is not part of the scenario contract and varies by response.
    ignoreBodyFields: ["messages.*.tool_calls.*.id", "messages.*.tool_call_id"],
  },
];
