import { describe, expect, it } from "vitest";
import { openAIChannels } from "./instrumentation/plugins/openai-channels";
import { wrapOpenAI } from "./wrappers/oai";
import {
  type APIPromise,
  createLazyAPIPromise,
} from "./wrappers/openai-promise-utils";

function apiPromise<T>(data: T, requestId: string): APIPromise<T> {
  const response = new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
  const promise = Promise.resolve(data) as APIPromise<T>;
  promise.withResponse = async () => ({
    data,
    response,
    request_id: requestId,
  });
  promise.asResponse = async () => response;
  return promise;
}

describe("OpenAI API promise wrappers", () => {
  it("forwards asResponse without parsing the response body", async () => {
    const response = new Response(JSON.stringify({ value: "raw" }), {
      headers: { "content-type": "application/json" },
    });
    const nativePromise = apiPromise({ value: "parsed" }, "req_raw");
    let tracedWithResponseCalls = 0;
    let tracedAsResponseCalls = 0;
    const wrapped = createLazyAPIPromise(
      async () => {
        tracedWithResponseCalls++;
        return { data: { value: "parsed" }, response };
      },
      async () => {
        tracedAsResponseCalls++;
        return response;
      },
      () => nativePromise,
    );

    const raw = await wrapped.asResponse();
    expect(tracedWithResponseCalls).toBe(0);
    expect(tracedAsResponseCalls).toBe(1);
    await expect(raw.json()).resolves.toEqual({ value: "raw" });
  });

  it("does not trace the request again when parsed after asResponse", async () => {
    const response = new Response(JSON.stringify({ value: "raw" }), {
      headers: { "content-type": "application/json" },
    });
    const nativePromise = apiPromise({ value: "parsed" }, "req_raw");
    let tracedWithResponseCalls = 0;
    let tracedAsResponseCalls = 0;
    const wrapped = createLazyAPIPromise(
      async () => {
        tracedWithResponseCalls++;
        return { data: { value: "parsed" }, response };
      },
      async () => {
        tracedAsResponseCalls++;
        return response;
      },
      () => nativePromise,
    );

    await wrapped.asResponse();
    await expect(wrapped).resolves.toEqual({ value: "parsed" });
    expect(tracedWithResponseCalls).toBe(0);
    expect(tracedAsResponseCalls).toBe(1);
  });

  it("dispatches the OpenAI channel lifecycle for asResponse-only calls", async () => {
    const phases: string[] = [];
    let result: unknown;
    const tracingChannel =
      openAIChannels.chatCompletionsCreate.tracingChannel();
    const handlers = {
      asyncEnd: (event: { result?: unknown }) => {
        phases.push("asyncEnd");
        result = event.result;
      },
      error: () => phases.push("error"),
      start: () => phases.push("start"),
    };
    tracingChannel.subscribe(handlers);

    try {
      const client = wrapOpenAI({
        chat: {
          completions: {
            create: (_params: { messages: unknown }) =>
              apiPromise({ choices: [] }, "req_raw"),
          },
        },
        embeddings: { create: () => apiPromise({ data: [] }, "req_embed") },
        moderations: {
          create: () => apiPromise({ results: [] }, "req_moderation"),
        },
      });

      const response = await client.chat.completions
        .create({ messages: [] })
        .asResponse();
      expect(response.bodyUsed).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      tracingChannel.unsubscribe(handlers);
    }

    expect(phases).toEqual(["start", "asyncEnd"]);
    expect(result).toBeUndefined();
  });

  it("does not consume a raw response body and preserves cancellation", async () => {
    let cancelled = false;
    let pulls = 0;
    const response = new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ choices: [] })),
            );
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
    const promise: APIPromise<{ choices: unknown[] }> = Object.assign(
      Promise.resolve({ choices: [] as unknown[] }),
      {
        asResponse: async () => response,
        withResponse: async () => ({ data: { choices: [] }, response }),
      },
    );
    const phases: string[] = [];
    const tracingChannel =
      openAIChannels.chatCompletionsCreate.tracingChannel();
    const handlers = {
      asyncEnd: () => phases.push("asyncEnd"),
      error: () => phases.push("error"),
      start: () => phases.push("start"),
    };
    tracingChannel.subscribe(handlers);

    try {
      const client = wrapOpenAI({
        chat: {
          completions: {
            create: (_params: { messages: unknown }) => promise,
          },
        },
        embeddings: { create: () => apiPromise({ data: [] }, "req_embed") },
        moderations: {
          create: () => apiPromise({ results: [] }, "req_moderation"),
        },
      });

      const raw = await client.chat.completions
        .create({ messages: [] })
        .asResponse();
      expect(raw).toBe(response);
      expect(raw.bodyUsed).toBe(false);
      expect(pulls).toBe(0);
      expect(phases).toEqual(["start", "asyncEnd"]);

      const reader = raw.body?.getReader();
      await reader?.read();
      await reader?.cancel();
      expect(cancelled).toBe(true);
    } finally {
      tracingChannel.unsubscribe(handlers);
    }
  });

  it.each([false, true])(
    "preserves request_id for chat responses with stream=%s",
    async (stream) => {
      const client = wrapOpenAI({
        chat: {
          completions: {
            create: (_params: { messages: unknown; stream?: boolean }) =>
              apiPromise({ choices: [] }, "req_chat"),
          },
        },
        embeddings: { create: () => apiPromise({ data: [] }, "req_embed") },
        moderations: {
          create: () => apiPromise({ results: [] }, "req_moderation"),
        },
      });

      await expect(
        client.chat.completions.create({ messages: [], stream }).withResponse(),
      ).resolves.toMatchObject({ request_id: "req_chat" });
    },
  );
});
