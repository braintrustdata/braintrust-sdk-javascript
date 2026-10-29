import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initLogger, wrapOpenAI, wrapAnthropic } from "braintrust";
import { MINIMAL_PNG_BASE64 } from "./media-fixtures.mjs";
import { scopedName } from "./provider-runtime.mjs";

export const captureCases = [
  { name: "default", env: "", enabled: false },
  { name: "local-default", env: "", global: true, local: true, enabled: false },
  {
    name: "local-enabled",
    env: "false",
    global: false,
    local: true,
    option: true,
    enabled: true,
  },
  {
    name: "local-disabled",
    env: "true",
    global: true,
    local: true,
    option: false,
    enabled: false,
  },
  {
    name: "local-environment",
    env: "true",
    global: false,
    local: true,
    enabled: true,
  },
  { name: "global-enabled", env: "false", option: true, enabled: true },
  { name: "global-disabled", env: "true", option: false, enabled: false },
];

export async function runAttachmentCaptureScenario(provider, scenarioUrl, sdk) {
  const wrapped = process.env.CAPTURE_WRAPPED === "true";
  let request;
  if (provider === "anthropic") {
    const raw = new sdk.default({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
    const client = wrapped ? wrapAnthropic(raw) : raw;
    const data = (
      await readFile(new URL("./test-image.png", scenarioUrl))
    ).toString("base64");
    request = async () => {
      const result = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 32,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Describe the attached image in one short sentence.",
              },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data },
              },
            ],
          },
        ],
      });
      assert.ok(result.content.length > 0);
    };
  } else if (provider === "openai") {
    const raw = new sdk.default({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
    const client = wrapped ? wrapOpenAI(raw) : raw;
    request = async () => {
      const result = await client.chat.completions.create({
        model: "gpt-4o-mini-2024-07-18",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Describe this image in three words or fewer.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${MINIMAL_PNG_BASE64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 24,
        temperature: 0,
      });
      assert.ok(result.choices[0].message.content);
    };
  }
  const projectName = scopedName("tmp-luca-attachment-capture");
  for (const testCase of captureCases) {
    process.env.BRAINTRUST_AUTO_CAPTURE_ATTACHMENTS = testCase.env;
    if (testCase.local)
      initLogger({ projectName, autoCaptureAttachments: testCase.global });
    const logger = initLogger({
      projectName,
      setCurrent: !testCase.local,
      autoCaptureAttachments: testCase.option,
    });
    await logger.traced(request, {
      name: `attachment-capture-${testCase.name}`,
      event: {
        metadata: {
          scenario: `${provider}-instrumentation`,
          testRunId: process.env.BRAINTRUST_E2E_RUN_ID,
        },
      },
    });
    await logger.flush();
  }
}
