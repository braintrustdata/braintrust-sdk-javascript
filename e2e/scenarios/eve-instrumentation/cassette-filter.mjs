// @ts-check
import { filter as aiSdkFilter } from "../ai-sdk-instrumentation/cassette-filter.mjs";

/** @type {import("@braintrust/seinfeld").FilterSpec} */
export const filter = [
  ...aiSdkFilter,
  {
    // Built-in tool definitions evolve between Eve releases without affecting
    // the recorded responses.
    ignoreBodyFields: ["tools"],
    // Eve 0.70+ runs subagents as tasks, so parent and subagent model calls
    // race. Matching on messages keeps each response with its call; task and
    // agent ids are random per run.
    normalizeRequest(request) {
      if (request.body.kind !== "json" || !request.body.value?.messages) {
        return request;
      }
      const messages = JSON.parse(
        JSON.stringify(request.body.value.messages)
          .replace(/\bresearcher-[a-z0-9]{6}\b/g, "researcher-<id>")
          .replace(/ag_researcher:[0-9a-f]+/g, "ag_researcher:<id>"),
      );
      return {
        ...request,
        body: { ...request.body, value: { ...request.body.value, messages } },
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
