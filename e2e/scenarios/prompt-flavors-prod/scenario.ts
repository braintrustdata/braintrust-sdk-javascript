import OpenAI from "openai";
import { loadPrompt, projects } from "braintrust";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function slugSuffix(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function omitSpanInfo<T extends { span_info?: unknown }>(
  prompt: T,
): Omit<T, "span_info"> {
  const { span_info: _spanInfo, ...rest } = prompt;
  return rest;
}

async function loadPromptWithRetry(
  options: Parameters<typeof loadPrompt>[0],
  attempts = 12,
): Promise<Awaited<ReturnType<typeof loadPrompt>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await loadPrompt(options);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      await sleep(1_000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const runId = requiredEnv("BRAINTRUST_E2E_RUN_ID");
const projectName = requiredEnv("BRAINTRUST_E2E_PROJECT_NAME");
const openAIApiKey = requiredEnv("OPENAI_API_KEY");
const suffix = slugSuffix(runId);
const openAI = new OpenAI({
  apiKey: openAIApiKey,
  ...(process.env.OPENAI_BASE_URL
    ? { baseURL: process.env.OPENAI_BASE_URL }
    : {}),
});

const chatSlug = `e2e-prompt-flavors-chat-${suffix}`;
const completionSlug = `e2e-prompt-flavors-completion-${suffix}`;

const project = projects.create({ name: projectName });

project.prompts.create({
  name: `E2E prompt flavors chat ${runId}`,
  slug: chatSlug,
  messages: [
    {
      role: "user",
      content: "What is the weather in {{city}}?",
    },
  ],
  model: "gpt-4o-mini",
  params: {
    max_tokens: 42,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "weather_summary",
        schema: {
          additionalProperties: false,
          type: "object",
          properties: {
            forecast: { type: "string" },
          },
          required: ["forecast"],
        },
        strict: true,
      },
    },
    verbosity: "medium",
  },
});

project.prompts.create({
  name: `E2E prompt flavors completion ${runId}`,
  slug: completionSlug,
  model: "gpt-4o-mini",
  prompt: "Summarize {{topic}} in one line.",
});

await project.publish();

const chatPrompt = await loadPromptWithRetry({
  projectName,
  slug: chatSlug,
});

const chatPromptById = await loadPromptWithRetry({
  id: chatPrompt.id,
});

const completionPrompt = await loadPromptWithRetry({
  projectName,
  slug: completionSlug,
});

const completionPromptByVersion = await loadPromptWithRetry({
  projectName,
  slug: completionSlug,
  version: completionPrompt.version,
});

const buildArgs = {
  city: "Paris",
};

const chatBuild = omitSpanInfo(chatPrompt.build(buildArgs));
const responsesBuild = omitSpanInfo(
  chatPromptById.build(buildArgs, {
    flavor: "responses",
  }),
);
const responsesBuildWithAttachments = omitSpanInfo(
  await chatPromptById.buildWithAttachments(buildArgs, { flavor: "responses" }),
);
const completionBuild = omitSpanInfo(
  completionPromptByVersion.build(
    { topic: "prompt flavors" },
    { flavor: "completion" },
  ),
);

const { reasoning_effort: _chatReasoningEffort, ...chatExecutionParams } =
  chatBuild;

const chatExecution = await openAI.chat.completions.create(chatExecutionParams);
const responsesExecution = await openAI.responses.create(responsesBuild);
const completionExecution = await openAI.responses.create({
  input: completionBuild.prompt,
  model: completionBuild.model,
  max_output_tokens: 64,
});

const summary = {
  builds: {
    chatPrompt: {
      id: chatPrompt.id,
      projectId: chatPrompt.projectId,
      slug: chatPrompt.slug,
      version: chatPrompt.version,
      build: chatBuild,
    },
    responsesPrompt: {
      id: chatPromptById.id,
      slug: chatPromptById.slug,
      version: chatPromptById.version,
      build: responsesBuild,
      buildWithAttachments: responsesBuildWithAttachments,
    },
    completionPrompt: {
      id: completionPromptByVersion.id,
      slug: completionPromptByVersion.slug,
      version: completionPromptByVersion.version,
      build: completionBuild,
    },
  },
  executions: {
    chatPrompt: {
      api: "chat.completions.create",
      finishReason: chatExecution.choices[0]?.finish_reason ?? null,
      hasContent: (chatExecution.choices[0]?.message.content?.length ?? 0) > 0,
    },
    responsesPrompt: {
      api: "responses.create",
      hasOutputText: responsesExecution.output_text.trim().length > 0,
      outputItemTypes: responsesExecution.output.map((item) => item.type),
      status: responsesExecution.status,
    },
    completionPrompt: {
      api: "responses.create",
      hasOutputText: completionExecution.output_text.trim().length > 0,
      outputItemTypes: completionExecution.output.map((item) => item.type),
      status: completionExecution.status,
    },
  },
};

process.stdout.write(`${JSON.stringify(summary)}\n`);
