export const filter = [
  "default",
  {
    normalizeRequest(request) {
      const url = new URL(request.url);
      if (
        url.hostname === "api.openai.com" &&
        url.pathname === "/v1/responses" &&
        request.method === "GET"
      ) {
        return {
          ...request,
          body: { kind: "empty" },
        };
      }
      if (
        url.hostname === "api.openai.com" &&
        url.pathname === "/v1/responses" &&
        request.method === "POST"
      ) {
        return {
          ...request,
          body: summarizeResponsesBody(request.body),
        };
      }

      return request;
    },
  },
];

function summarizeResponsesBody(body) {
  if (body?.kind !== "json" || !body.value || typeof body.value !== "object") {
    return body;
  }

  const input = Array.isArray(body.value.input) ? body.value.input : [];
  let marker = "unknown";
  let hasToolOutput = false;

  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (
      item.type === "function_call_output" ||
      item.type === "local_shell_call_output" ||
      item.type === "computer_call_output"
    ) {
      hasToolOutput = true;
    }
    const text = textFromContent(item.content);
    if (text.includes("OPENAI_CODEX_RUN_OK")) {
      marker = "run";
    } else if (text.includes("OPENAI_CODEX_STREAM_OK")) {
      marker = "stream";
    }
  }

  return {
    kind: "json",
    value: {
      generate: body.value.generate ?? null,
      has_tool_output: hasToolOutput,
      marker,
      stream: body.value.stream ?? null,
    },
  };
}

function textFromContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => (typeof part?.text === "string" ? [part.text] : []))
    .join("\n");
}
