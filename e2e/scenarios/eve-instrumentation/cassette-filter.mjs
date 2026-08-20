// @ts-check
const EVE_BUILTIN_TOOLS = new Set([
  "agent",
  "ask_question",
  "bash",
  "glob",
  "grep",
  "load_skill",
  "read_file",
  "todo",
  "web_fetch",
  "write_file",
]);

/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  "default",
  {
    ignoreBodyFields: [
      "experimental_generateMessageId",
      "messageId",
      "messages.*.id",
      "messages.*.experimental_messageId",
      // Eve changed the runtime-owned subagent output-schema declaration
      // without changing this fixture's authored tool contract.
      "tools.*.function.parameters.properties.outputSchema",
      // JSON Schema's draft marker is metadata, not part of the accepted input.
      "tools.*.function.parameters.$schema",
    ],
    normalizeRequest(request) {
      if (
        request.body.kind !== "json" ||
        request.body.value === null ||
        typeof request.body.value !== "object" ||
        Array.isArray(request.body.value)
      ) {
        return request;
      }
      const body = request.body.value;
      if (!Array.isArray(body.tools)) {
        return request;
      }
      const messages = Array.isArray(body.messages)
        ? body.messages.map((message) => message)
        : body.messages;
      if (Array.isArray(messages)) {
        for (let index = 0; index < messages.length; index++) {
          const message = messages[index];
          if (
            message === null ||
            typeof message !== "object" ||
            !("role" in message) ||
            message.role !== "tool"
          ) {
            continue;
          }
          let end = index + 1;
          while (
            end < messages.length &&
            messages[end] !== null &&
            typeof messages[end] === "object" &&
            "role" in messages[end] &&
            messages[end].role === "tool"
          ) {
            end++;
          }
          messages.splice(
            index,
            end - index,
            ...messages.slice(index, end).sort((left, right) => {
              const leftName =
                left !== null &&
                typeof left === "object" &&
                "name" in left &&
                typeof left.name === "string"
                  ? left.name
                  : "";
              const rightName =
                right !== null &&
                typeof right === "object" &&
                "name" in right &&
                typeof right.name === "string"
                  ? right.name
                  : "";
              return leftName.localeCompare(rightName);
            }),
          );
          index = end - 1;
        }
      }
      return {
        ...request,
        body: {
          kind: "json",
          value: {
            ...body,
            messages,
            tools: body.tools.filter(
              (tool) =>
                tool === null ||
                typeof tool !== "object" ||
                !("function" in tool) ||
                tool.function === null ||
                typeof tool.function !== "object" ||
                !("name" in tool.function) ||
                typeof tool.function.name !== "string" ||
                !EVE_BUILTIN_TOOLS.has(tool.function.name),
            ),
          },
        },
      };
    },
  },
];

/** @type {import("@braintrust/seinfeld").RedactionSpec} */
export const redact = [
  "paranoid",
  {
    redactResponse(response) {
      return {
        ...response,
        headers: Object.fromEntries(
          Object.entries(response.headers).filter(
            ([key]) =>
              key.toLowerCase() !== "openai-organization" &&
              key.toLowerCase() !== "openai-project",
          ),
        ),
      };
    },
  },
];
