import { initLogger, startSpan, withCurrent, wrapOpenAI } from "braintrust";
import { collectAsync, getTestRunId, scopedName } from "./helpers";

const OPENAI_MODEL = "gpt-4o-mini";

export async function runWrapOpenAIConversationTraces(
  OpenAI: any,
  openaiSdkVersion: string,
) {
  const testRunId = getTestRunId();
  const logger = initLogger({
    projectName: scopedName("e2e-wrap-openai-conversation", testRunId),
  });
  const client = wrapOpenAI(
    new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      baseURL: process.env.OPENAI_BASE_URL,
    }),
  );

  await logger.traced(
    async () => {
      const chatSpan = startSpan({
        name: "openai-chat-operation",
        event: {
          metadata: {
            operation: "chat",
            testRunId,
          },
        },
      });
      await withCurrent(chatSpan, async () => {
        await client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            {
              role: "user",
              content: "Reply with exactly OK.",
            },
          ],
          max_tokens: 8,
          temperature: 0,
        });
      });
      chatSpan.end();

      const streamSpan = startSpan({
        name: "openai-stream-operation",
        event: {
          metadata: {
            operation: "stream",
            testRunId,
          },
        },
      });
      await withCurrent(streamSpan, async () => {
        const chatStream = await client.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            {
              role: "user",
              content: "Reply with exactly STREAM.",
            },
          ],
          stream: true,
          max_tokens: 8,
          temperature: 0,
          stream_options: {
            include_usage: true,
          },
        });
        await collectAsync(chatStream);
      });
      streamSpan.end();

      const responsesSpan = startSpan({
        name: "openai-responses-operation",
        event: {
          metadata: {
            operation: "responses",
            testRunId,
          },
        },
      });
      await withCurrent(responsesSpan, async () => {
        await client.responses.create({
          model: OPENAI_MODEL,
          input: "Reply with exactly PARIS.",
          max_output_tokens: 16,
        });
      });
      responsesSpan.end();
    },
    {
      name: "openai-wrapper-root",
      event: {
        metadata: {
          scenario: "wrap-openai-conversation-traces",
          openaiSdkVersion,
          testRunId,
        },
      },
    },
  );

  await logger.flush();
}
