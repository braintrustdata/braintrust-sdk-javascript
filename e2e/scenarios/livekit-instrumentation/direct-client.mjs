// An application-owned HTTP client: real OpenAI traffic without the OpenAI SDK.
// This exercises ownership independently of the provider/model name.
export function directClient() {
  const request = async (endpoint, body, options = {}) => {
    const response = await fetch(
      `${process.env.OPENAI_BASE_URL.replace(/\/$/, "")}/${endpoint}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "replay"}`,
          ...(body instanceof FormData
            ? {}
            : { "content-type": "application/json" }),
        },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: options.signal,
      },
    );
    if (!response.ok)
      throw new Error(
        `OpenAI HTTP ${response.status}: ${await response.text()}`,
      );
    return response;
  };
  return {
    chat: {
      completions: {
        async *create(params, options) {
          const response = await request("chat/completions", params, options);
          const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();
          let pending = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              pending += value.replace(/\r\n/g, "\n");
              let boundary;
              while ((boundary = pending.indexOf("\n\n")) !== -1) {
                const event = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const data = event
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .join("\n");
                if (data === "[DONE]") return;
                if (data) yield JSON.parse(data);
              }
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        },
      },
    },
    audio: {
      speech: {
        create: (params, options) => request("audio/speech", params, options),
      },
      transcriptions: {
        async create(params, options) {
          const form = new FormData();
          form.set("file", params.file);
          form.set("model", params.model);
          return (await request("audio/transcriptions", form, options)).json();
        },
      },
    },
  };
}
