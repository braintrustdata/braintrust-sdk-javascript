#!/usr/bin/env node

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const isStream = input.includes("stream");
  const suffix = isStream ? "STREAM_OK" : "RUN_OK";
  const threadId = isStream ? "thread_stream" : "thread_run";
  const events = [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: `${threadId}_command`,
        type: "command_execution",
        command: "printf codex_tool_ok",
        aggregated_output: "",
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: `${threadId}_command`,
        type: "command_execution",
        command: "printf codex_tool_ok",
        aggregated_output: "codex_tool_ok",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.started",
      item: {
        id: `${threadId}_mcp`,
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        arguments: { path: "README.md" },
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: `${threadId}_mcp`,
        type: "mcp_tool_call",
        server: "filesystem",
        tool: "read_file",
        arguments: { path: "README.md" },
        result: {
          content: [{ type: "text", text: "mock file" }],
          structured_content: { ok: true },
        },
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: `${threadId}_web`,
        type: "web_search",
        query: "braintrust codex instrumentation",
      },
    },
    {
      type: "item.completed",
      item: {
        id: `${threadId}_reasoning`,
        type: "reasoning",
        text: `reasoning ${suffix}`,
      },
    },
    {
      type: "item.completed",
      item: {
        id: `${threadId}_message`,
        type: "agent_message",
        text: `Codex ${suffix}`,
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 11,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_output_tokens: 5,
      },
    },
  ];

  for (const event of events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
});
