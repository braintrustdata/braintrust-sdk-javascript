import { describe, expect, test } from "vitest";
import {
  prompt,
  s,
  type InputOf,
  type OutputOf,
} from "./experimental-prompt-api";

describe("experimental prompt API", () => {
  test("builds typed prompts and translates to OpenAI chat args", () => {
    const supportReply = prompt.define({
      slug: "support-reply",
      model: "gpt-4o",
      input: s.object({
        ticket: s.string(),
      }),
      output: s.object({
        subject: s.string(),
        body: s.string(),
        urgency: s.enum(["low", "medium", "high"]),
      }),
      render: ({ input }) => [
        prompt.system`You write concise support replies.`,
        prompt.user`Ticket: ${input.ticket}`,
      ],
    });

    type SupportReplyInput = InputOf<typeof supportReply>;
    type SupportReplyOutput = OutputOf<typeof supportReply>;

    const input: SupportReplyInput = { ticket: "I cannot find eval history." };
    const output: SupportReplyOutput = {
      subject: "Finding eval history",
      body: "Here is where to look.",
      urgency: "low",
    };

    const built = supportReply.build(input);
    expect(built.parseOutput(output)).toEqual(output);
    expect(built.to(prompt.adapters.openAIChat)).toMatchObject({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You write concise support replies." },
        { role: "user", content: "Ticket: I cannot find eval history." },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "support-reply_output",
          strict: true,
          schema: {
            type: "object",
            required: ["subject", "body", "urgency"],
          },
        },
      },
      span_info: {
        metadata: {
          prompt: {
            root: { slug: "support-reply" },
            prompts: [
              {
                slug: "support-reply",
                role: "root",
                input,
              },
            ],
          },
        },
      },
    });
  });

  test("includes nested prompts and records prompt dependencies", () => {
    const brandVoice = prompt.define({
      slug: "brand-voice",
      version: "v3",
      input: s.object({
        company: s.string(),
      }),
      render: ({ input }) => [
        prompt.system`Use ${input.company}'s voice. Be warm and direct.`,
      ],
    });

    const supportReply = prompt.define({
      slug: "support-reply",
      version: "v8",
      input: s.object({
        company: s.string(),
        ticket: s.string(),
      }),
      render: ({ input, include }) => [
        include(brandVoice, { company: input.company }),
        prompt.user`Draft a reply for: ${input.ticket}`,
      ],
    });

    const built = supportReply.build({
      company: "Braintrust",
      ticket: "Where did my experiment go?",
    });

    expect(built.messages).toEqual([
      {
        role: "system",
        content: "Use Braintrust's voice. Be warm and direct.",
      },
      {
        role: "user",
        content: "Draft a reply for: Where did my experiment go?",
      },
    ]);
    expect(built.dependencies.prompts).toMatchObject([
      {
        slug: "support-reply",
        version: "v8",
        role: "root",
      },
      {
        slug: "brand-voice",
        version: "v3",
        role: "include",
        parent: "support-reply",
        input: { company: "Braintrust" },
      },
    ]);
  });

  test("builds schema prompt fields from merged parent input and overrides", () => {
    const brandVoice = prompt.define({
      slug: "brand-voice",
      version: "v3",
      input: s.object({
        company: s.string(),
        tone: s.string(),
      }),
      render: ({ input }) => [
        prompt.system`Use ${input.company}'s ${input.tone} voice.`,
      ],
    });

    const supportReply = prompt.define({
      slug: "support-reply",
      version: "v8",
      input: s.object({
        company: s.string(),
        ticket: s.string(),
        voice: s.prompt(brandVoice),
      }),
      render: ({ input }) => [
        input.voice,
        prompt.user`Draft a reply for: ${input.ticket}`,
      ],
    });

    type SupportReplyInput = InputOf<typeof supportReply>;
    const input: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      voice: { tone: "direct" },
    };

    const built = supportReply.build(input);

    expect(built.messages).toEqual([
      {
        role: "system",
        content: "Use Braintrust's direct voice.",
      },
      {
        role: "user",
        content: "Draft a reply for: Where did my experiment go?",
      },
    ]);
    expect(built.dependencies.prompts).toMatchObject([
      {
        slug: "support-reply",
        role: "root",
        input: {
          company: "Braintrust",
          ticket: "Where did my experiment go?",
          voice: {
            type: "built_prompt",
            root: { slug: "brand-voice", version: "v3" },
          },
        },
      },
      {
        slug: "brand-voice",
        version: "v3",
        role: "include",
        parent: "support-reply",
        input: {
          company: "Braintrust",
          tone: "direct",
        },
      },
    ]);
  });

  test("allows dynamic s.prompt fields that receive a prompt definition", () => {
    const brandVoice = prompt.define({
      slug: "brand-voice",
      input: s.object({
        company: s.string(),
        tone: s.string(),
      }),
      render: ({ input }) => [
        prompt.system`Use ${input.company}'s ${input.tone} voice.`,
      ],
    });

    const supportReply = prompt.define({
      slug: "support-reply",
      input: s.object({
        company: s.string(),
        ticket: s.string(),
        voice: s.prompt(),
      }),
      render: ({ input }) => [
        input.voice,
        prompt.user`Draft a reply for: ${input.ticket}`,
      ],
    });

    const built = supportReply.build({
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      voice: {
        prompt: brandVoice,
        input: { tone: "calm" },
      },
    });

    expect(built.messages).toEqual([
      {
        role: "system",
        content: "Use Braintrust's calm voice.",
      },
      {
        role: "user",
        content: "Draft a reply for: Where did my experiment go?",
      },
    ]);
  });

  test("accepts a built prompt as input and sanitizes dependencies", () => {
    const summarizeTicket = prompt.define({
      slug: "summarize-ticket",
      input: s.object({
        ticket: s.string(),
      }),
      render: ({ input }) => [prompt.user`Summarize: ${input.ticket}`],
    });

    const critiquePrompt = prompt.define({
      slug: "critique-prompt",
      input: s.object({
        prior: s.builtPrompt(),
      }),
      render: ({ input }) => [
        prompt.user`Critique this prompt:\n${prompt.asText(input.prior)}`,
      ],
    });

    const prior = summarizeTicket.build({ ticket: "Billing looks wrong." });
    const built = critiquePrompt.build({ prior });

    expect(built.messages).toEqual([
      {
        role: "user",
        content: "Critique this prompt:\nuser: Summarize: Billing looks wrong.",
      },
    ]);
    expect(built.dependencies.prompts[0].input).toEqual({
      prior: {
        type: "built_prompt",
        root: {
          slug: "summarize-ticket",
        },
      },
    });
  });

  test("validates input and output with the bundled schema DSL", () => {
    const typedPrompt = prompt.define({
      slug: "typed",
      input: s.object({
        count: s.number(),
      }),
      output: s.object({
        ok: s.boolean(),
      }),
      render: ({ input }) => [prompt.user`Count: ${input.count}`],
    });

    expect(() => typedPrompt.build({ count: "nope" })).toThrow(
      "input.count must be a number",
    );
    expect(() =>
      typedPrompt.build({ count: 1 }).parseOutput({ ok: "yes" }),
    ).toThrow("output.ok must be a boolean");
  });

  test("translates to an AI SDK shaped object", () => {
    const classify = prompt.define({
      slug: "classify",
      model: "gpt-4o-mini",
      input: s.object({
        text: s.string(),
      }),
      output: s.object({
        label: s.enum(["bug", "question"]),
      }),
      render: ({ input }) => [prompt.user`Classify: ${input.text}`],
    });

    expect(
      classify
        .build({ text: "It crashes" })
        .to(prompt.adapters.aiSDKGenerateObject),
    ).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Classify: It crashes" }],
      schema: {
        type: "object",
        required: ["label"],
      },
      experimental_telemetry: {
        metadata: {
          braintrustPrompt: {
            root: { slug: "classify" },
          },
        },
      },
    });
  });
});
