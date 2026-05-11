#!/usr/bin/env node

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const isStream =
    input.includes("OPENAI_CODEX_STREAM_OK") || input.includes("stream");
  const marker = isStream ? "OPENAI_CODEX_STREAM_OK" : "OPENAI_CODEX_RUN_OK";
  const threadId = isStream ? "thread_stream" : "thread_run";
  const events = [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: `${threadId}_reasoning_before_command`,
        type: "reasoning",
        text: `reasoning before command ${marker}`,
      },
    },
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
      type: "item.completed",
      item: {
        id: `${threadId}_reasoning_after_command`,
        type: "reasoning",
        text: `reasoning after command ${marker}`,
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
        id: `${threadId}_reasoning_after_mcp`,
        type: "reasoning",
        text: `reasoning after mcp ${marker}`,
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
        text: `final reasoning ${marker}`,
      },
    },
    {
      type: "item.completed",
      item: {
        id: `${threadId}_message`,
        type: "agent_message",
        text: `Codex ${marker}`,
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 11,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_output_tokens: 5,
        total_tokens: 18,
      },
    },
  ];

  for (const event of events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
});
