import { describe, expect, test } from "vitest";
import { prompt } from "./experimental-prompt-api";

describe("experimental prompt API", () => {
  test("builds message prompts and translates to OpenAI chat args", () => {
    const supportReply = prompt.define({
      slug: "support-reply",
      model: "gpt-4o",
      input: (s) =>
        s.object({
          ticket: s.string(),
        }),
      output: (s) =>
        s.object({
          subject: s.string(),
          body: s.string(),
          urgency: s.enum(["low", "medium", "high"]),
        }),
      render: ({ input }) => [
        prompt.system`You write concise support replies.`,
        prompt.user`Ticket: ${input.ticket}`,
      ],
    });

    const built = supportReply.build({
      ticket: "I cannot find eval history.",
    });
    const output = {
      subject: "Finding eval history",
      body: "Here is where to look.",
      urgency: "low",
    };

    expect(built.kind).toBe("messages");
    expect("content" in built).toBe(false);
    expect([...built]).toEqual(built.messages);
    expect(built.definition.outputSchema?.parse(output, "output")).toEqual(
      output,
    );
    expect(built.to(prompt.adapters.openAIChat())).toMatchObject({
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
                input: { ticket: "I cannot find eval history." },
              },
            ],
          },
        },
      },
    });

    if (false) {
      // @ts-expect-error message prompts do not expose string content
      void built.content;
    }
  });

  test("builds string prompts and coerces adapters to a user message", () => {
    const policyText = prompt.define({
      slug: "policy-text",
      model: "gpt-4o-mini",
      input: (s) =>
        s.object({
          policy: s.string(),
        }),
      render: ({ input }) => prompt.text`Policy: ${input.policy}`,
    });

    const built = policyText.build({ policy: "Prefer short answers." });

    expect(built.kind).toBe("string");
    expect(built.content).toBe("Policy: Prefer short answers.");
    expect("messages" in built).toBe(false);
    expect(built.to(prompt.adapters.openAIChat())).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Policy: Prefer short answers." }],
      span_info: {
        metadata: {
          prompt: {
            root: { slug: "policy-text" },
          },
        },
      },
    });
    expect(
      built.to((snapshot) => ({
        kind: snapshot.kind,
        content: snapshot.kind === "string" ? snapshot.content : undefined,
        messages: snapshot.messages,
      })),
    ).toEqual({
      kind: "string",
      content: "Policy: Prefer short answers.",
      messages: [{ role: "user", content: "Policy: Prefer short answers." }],
    });

    if (false) {
      // @ts-expect-error string prompts do not expose messages
      void built.messages;
      // @ts-expect-error string prompts are not iterable
      void [...built];
    }
  });

  test("extends adapter args with a typed deep merge", () => {
    const classify = prompt.define({
      slug: "classify",
      model: "gpt-4o-mini",
      input: (s) =>
        s.object({
          text: s.string(),
        }),
      output: (s) =>
        s.object({
          label: s.enum(["bug", "question"]),
        }),
      render: ({ input }) => [prompt.user`Classify: ${input.text}`],
    });

    const built = classify.build({ text: "It crashes" });
    const args = built.to(prompt.adapters.openAIChat());
    const extended = args.extend({
      temperature: 0.2,
      span_info: {
        metadata: {
          caller: "support-workflow",
        },
      },
    });
    const extendedAgain = extended.extend({
      top_p: 0.5,
      span_info: {
        metadata: {
          requestId: "req_123",
        },
      },
    });

    expect(Object.keys(args)).not.toContain("extend");
    expect({ ...args }).not.toHaveProperty("extend");
    expect(extended).toMatchObject({
      temperature: 0.2,
      span_info: {
        metadata: {
          caller: "support-workflow",
          prompt: {
            root: { slug: "classify" },
          },
        },
      },
    });
    expect(extendedAgain).toMatchObject({
      temperature: 0.2,
      top_p: 0.5,
      span_info: {
        metadata: {
          caller: "support-workflow",
          requestId: "req_123",
          prompt: {
            root: { slug: "classify" },
          },
        },
      },
    });
    expect(() => built.to(() => "nope" as never)).toThrow(
      "prompt adapters must return an object",
    );
    expect(() => built.to(() => [] as never)).toThrow(
      "prompt adapters must return an object",
    );
    expect(() => args.extend("nope" as never)).toThrow(
      "extend must receive an object",
    );

    if (false) {
      // @ts-expect-error adapters must return objects
      void built.to(() => "nope");

      const typedArgs = built.to(prompt.adapters.openAIChat()).extend({
        temperature: 0.2,
        span_info: {
          metadata: {
            caller: "support-workflow",
          },
        },
      });
      const temperature: number = typedArgs.temperature;
      const caller: string = typedArgs.span_info.metadata.caller;
      const slug: string = typedArgs.span_info.metadata.prompt.root.slug;
      void temperature;
      void caller;
      void slug;

      // @ts-expect-error extend only accepts objects
      void typedArgs.extend("nope");
    }
  });

  test("auto-builds message prompt inputs and preserves spread dependencies", () => {
    const brandVoice = prompt.define({
      slug: "brand-voice",
      version: "v3",
      input: (s) =>
        s.object({
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
      input: (s) =>
        s.object({
          company: s.string(),
          ticket: s.string(),
          voice: s.messagesPromptDefinition(brandVoice),
        }),
      render: ({ input }) => [
        ...input.voice,
        prompt.user`Draft a reply for: ${input.ticket}`,
      ],
    });

    type SupportReplyInput = Parameters<typeof supportReply.build>[0];
    const input: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      voice: { tone: "direct" },
    };
    const overriddenNestedPromptInput: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      voice: { company: "Acme", tone: "direct" },
    };
    void overriddenNestedPromptInput;
    const missingNestedPromptInput: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      // @ts-expect-error nested prompt input still needs fields that are not supplied by the parent input
      voice: {},
    };
    void missingNestedPromptInput;
    const unbuiltNestedPromptInput: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      // @ts-expect-error raw prompt definitions are not prompt inputs
      voice: brandVoice,
    };
    void unbuiltNestedPromptInput;
    const dynamicPromptDefinitionInput: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      // @ts-expect-error prompt definition payloads are not prompt inputs
      voice: { prompt: brandVoice, input: { tone: "direct" } },
    };
    void dynamicPromptDefinitionInput;

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
            type: "built_messages_prompt",
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
    expect(() =>
      supportReply.build({
        company: "Braintrust",
        ticket: "Where did my experiment go?",
        voice: brandVoice as never,
      }),
    ).toThrow("input.voice must be a built messages prompt or prompt input");
  });

  test("auto-builds string prompt inputs and preserves interpolation dependencies", () => {
    const policyText = prompt.define({
      slug: "policy-text",
      version: "v2",
      input: (s) =>
        s.object({
          company: s.string(),
          policy: s.string(),
        }),
      render: ({ input }) => prompt.text`${input.company}: ${input.policy}`,
    });

    const supportReply = prompt.define({
      slug: "support-reply",
      input: (s) =>
        s.object({
          company: s.string(),
          ticket: s.string(),
          policy: s.stringPromptDefinition(policyText),
        }),
      render: ({ input }) => [
        prompt.system`Follow this policy: ${input.policy}`,
        prompt.user`Draft a reply for: ${input.ticket}`,
      ],
    });

    type SupportReplyInput = Parameters<typeof supportReply.build>[0];
    const input: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      policy: { policy: "Be concise." },
    };
    const invalidPolicyInput: SupportReplyInput = {
      company: "Braintrust",
      ticket: "Where did my experiment go?",
      // @ts-expect-error nested string prompt input still needs fields that are not supplied by the parent input
      policy: {},
    };
    void invalidPolicyInput;

    const built = supportReply.build(input);

    expect(built.messages).toEqual([
      {
        role: "system",
        content: "Follow this policy: Braintrust: Be concise.",
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
          policy: {
            type: "built_string_prompt",
            root: { slug: "policy-text", version: "v2" },
          },
        },
      },
      {
        slug: "policy-text",
        version: "v2",
        role: "include",
        parent: "support-reply",
        input: {
          company: "Braintrust",
          policy: "Be concise.",
        },
      },
    ]);
  });

  test("requires matching built prompt kinds for dynamic schemas", () => {
    const messagePrompt = prompt.define({
      slug: "message-prompt",
      input: (s) =>
        s.object({
          topic: s.string(),
        }),
      render: ({ input }) => [prompt.user`Message about ${input.topic}`],
    });
    const stringPrompt = prompt.define({
      slug: "string-prompt",
      input: (s) =>
        s.object({
          topic: s.string(),
        }),
      render: ({ input }) => prompt.text`String about ${input.topic}`,
    });

    const consumeBoth = prompt.define({
      slug: "consume-both",
      input: (s) =>
        s.object({
          messagePart: s.builtMessagesPrompt(),
          stringPart: s.builtStringPrompt(),
        }),
      render: ({ input }) => [
        ...input.messagePart,
        prompt.user`Fragment: ${input.stringPart}`,
      ],
    });

    const messagePart = messagePrompt.build({ topic: "tracing" });
    const stringPart = stringPrompt.build({ topic: "evals" });

    type ConsumeBothInput = Parameters<typeof consumeBoth.build>[0];
    const wrongMessageKind: ConsumeBothInput = {
      // @ts-expect-error string prompts cannot satisfy message prompt schemas
      messagePart: stringPart,
      stringPart,
    };
    void wrongMessageKind;
    const wrongStringKind: ConsumeBothInput = {
      messagePart,
      // @ts-expect-error message prompts cannot satisfy string prompt schemas
      stringPart: messagePart,
    };
    void wrongStringKind;
    const rawDefinitionInput: ConsumeBothInput = {
      // @ts-expect-error raw prompt definitions are not prompt inputs
      messagePart: messagePrompt,
      stringPart,
    };
    void rawDefinitionInput;
    const dynamicPayloadInput: ConsumeBothInput = {
      messagePart: {
        // @ts-expect-error prompt definition payloads are not prompt inputs
        prompt: messagePrompt,
        input: { topic: "tracing" },
      },
      stringPart,
    };
    void dynamicPayloadInput;

    const built = consumeBoth.build({ messagePart, stringPart });

    expect(built.messages).toEqual([
      { role: "user", content: "Message about tracing" },
      { role: "user", content: "Fragment: String about evals" },
    ]);
    expect(() =>
      consumeBoth.build({ messagePart: stringPart as never, stringPart }),
    ).toThrow("input.messagePart must be a built messages prompt");
    expect(() =>
      consumeBoth.build({ messagePart, stringPart: messagePart as never }),
    ).toThrow("input.stringPart must be a built string prompt");
  });

  test("preserves dependencies through spread and interpolation outside schema inputs", () => {
    const messagePrompt = prompt.define({
      slug: "message-prompt",
      input: (s) =>
        s.object({
          topic: s.string(),
        }),
      render: ({ input }) => [prompt.user`Message about ${input.topic}`],
    });
    const stringPrompt = prompt.define({
      slug: "string-prompt",
      input: (s) =>
        s.object({
          topic: s.string(),
        }),
      render: ({ input }) => prompt.text`String about ${input.topic}`,
    });

    const messagePart = messagePrompt.build({ topic: "tracing" });
    const stringPart = stringPrompt.build({ topic: "evals" });
    const wrapper = prompt.define({
      slug: "wrapper",
      input: (s) => s.object({}),
      render: () => [...messagePart, prompt.user`Fragment: ${stringPart}`],
    });

    const built = wrapper.build({});

    expect(built.dependencies.prompts).toMatchObject([
      { slug: "wrapper", role: "root" },
      { slug: "message-prompt", role: "include", parent: "wrapper" },
      { slug: "string-prompt", role: "include", parent: "wrapper" },
    ]);
  });

  test("validates input, output, and render shapes", () => {
    const typedPrompt = prompt.define({
      slug: "typed",
      input: (s) =>
        s.object({
          count: s.number(),
        }),
      output: (s) =>
        s.object({
          ok: s.boolean(),
        }),
      render: ({ input }) => [prompt.user`Count: ${input.count}`],
    });
    const invalidRenderPrompt = prompt.define({
      slug: "invalid-render",
      input: (s) => s.object({}),
      // @ts-expect-error render must return a message array or prompt.text
      render: () => prompt.user`Nope`,
    });

    expect(() =>
      // @ts-expect-error runtime validation rejects invalid input too
      typedPrompt.build({ count: "nope" }),
    ).toThrow("input.count must be a number");
    const built = typedPrompt.build({ count: 1 });
    expect(() =>
      built.definition.outputSchema?.parse({ ok: "yes" }, "output"),
    ).toThrow("output.ok must be a boolean");
    expect(() => invalidRenderPrompt.build({})).toThrow(
      "render must return a message array or prompt.text",
    );
  });

  test("passes scoped schema helpers to input and output callbacks", () => {
    let inputHelperKeys: string[] = [];
    let outputHelperKeys: string[] = [];
    const typedPrompt = prompt.define({
      slug: "schema-helper-scopes",
      input: (s) => {
        inputHelperKeys = Object.keys(s).sort();
        return s.object({
          topic: s.string(),
        });
      },
      output: (s) => {
        outputHelperKeys = Object.keys(s).sort();
        return s.object({
          ok: s.boolean(),
        });
      },
      render: ({ input }) => [prompt.user`Topic: ${input.topic}`],
    });

    expect(inputHelperKeys).toContain("builtMessagesPrompt");
    expect(inputHelperKeys).toContain("stringPromptDefinition");
    expect(outputHelperKeys).toContain("object");
    expect(outputHelperKeys).not.toContain("builtMessagesPrompt");
    expect(outputHelperKeys).not.toContain("builtStringPrompt");
    expect(outputHelperKeys).not.toContain("messagesPromptDefinition");
    expect(outputHelperKeys).not.toContain("stringPromptDefinition");

    if (false) {
      prompt.define({
        slug: "raw-input-schema",
        // @ts-expect-error input must be a schema function
        input: typedPrompt.inputSchema,
        render: () => [prompt.user`Nope`],
      });

      prompt.define({
        slug: "raw-output-schema",
        input: (s) => s.object({}),
        // @ts-expect-error output must be a schema function
        output: typedPrompt.outputSchema,
        render: () => [prompt.user`Nope`],
      });

      prompt.define({
        slug: "prompt-output-field",
        input: (s) => s.object({}),
        output: (s) =>
          s.object({
            // @ts-expect-error output schema helpers do not include prompt helpers
            prompt: s.builtMessagesPrompt(),
          }),
        render: () => [prompt.user`Nope`],
      });

      prompt.define({
        slug: "prompt-output-array",
        input: (s) => s.object({}),
        output: (s) =>
          // @ts-expect-error output schema helpers do not include prompt helpers
          s.array(s.builtStringPrompt()),
        render: () => [prompt.user`Nope`],
      });
    }

    expect(() =>
      prompt.define({
        slug: "runtime-raw-input-schema",
        input: typedPrompt.inputSchema as never,
        render: () => [prompt.user`Nope`],
      }),
    ).toThrow("input must be a schema function");
    expect(() =>
      prompt.define({
        slug: "runtime-raw-output-schema",
        input: (s) => s.object({}),
        output: typedPrompt.outputSchema as never,
        render: () => [prompt.user`Nope`],
      }),
    ).toThrow("output must be a schema function");
  });

  test("passes flat prompt snapshots to custom adapters", () => {
    const classify = prompt.define({
      slug: "classify",
      model: "gpt-4o-mini",
      input: (s) =>
        s.object({
          text: s.string(),
        }),
      output: (s) =>
        s.object({
          label: s.enum(["bug", "question"]),
        }),
      render: ({ input }) => [prompt.user`Classify: ${input.text}`],
    });
    const summarize = prompt.define({
      slug: "summarize",
      input: (s) =>
        s.object({
          text: s.string(),
        }),
      render: ({ input }) => prompt.text`Summarize: ${input.text}`,
    });

    expect(
      classify.build({ text: "It crashes" }).to((snapshot) => ({
        keys: Object.keys(snapshot).sort(),
        kind: snapshot.kind,
        inputSchema: snapshot.inputSchema.toJSONSchema(),
        outputSchema: snapshot.outputSchema?.toJSONSchema(),
        input: snapshot.input,
      })),
    ).toMatchObject({
      keys: [
        "dependencies",
        "input",
        "inputSchema",
        "kind",
        "messages",
        "model",
        "outputSchema",
      ],
      kind: "messages",
      inputSchema: {
        type: "object",
        required: ["text"],
      },
      outputSchema: {
        type: "object",
        required: ["label"],
      },
      input: { text: "It crashes" },
    });
    expect(
      summarize.build({ text: "It crashes" }).to((snapshot) => ({
        keys: Object.keys(snapshot).sort(),
        kind: snapshot.kind,
        content: snapshot.kind === "string" ? snapshot.content : undefined,
        messages: snapshot.messages,
      })),
    ).toEqual({
      keys: [
        "content",
        "dependencies",
        "input",
        "inputSchema",
        "kind",
        "messages",
        "model",
        "outputSchema",
      ],
      kind: "string",
      content: "Summarize: It crashes",
      messages: [{ role: "user", content: "Summarize: It crashes" }],
    });
  });

  test("input schema helper exposes only the explicit built prompt helpers", () => {
    prompt.define({
      slug: "input-helper-surface",
      input: (s) => {
        expect("builtMessagesPrompt" in s).toBe(true);
        expect("builtStringPrompt" in s).toBe(true);
        expect("messagesPromptDefinition" in s).toBe(true);
        expect("stringPromptDefinition" in s).toBe(true);
        expect("prompt" in s).toBe(false);
        expect("builtPrompt" in s).toBe(false);
        expect("promptDefinition" in s).toBe(false);

        if (false) {
          // @ts-expect-error built message prompt schemas only accept already-built prompts
          void s.builtMessagesPrompt(undefined);
          // @ts-expect-error built string prompt schemas only accept already-built prompts
          void s.builtStringPrompt(undefined);
          // @ts-expect-error message prompt definition schemas require a definition
          void s.messagesPromptDefinition();
          // @ts-expect-error string prompt definition schemas require a definition
          void s.stringPromptDefinition();
          // @ts-expect-error old generic prompt schema helper was removed
          void s.prompt;
          // @ts-expect-error old generic built prompt schema helper was removed
          void s.builtPrompt;
          // @ts-expect-error prompt definitions are no longer accepted as schema inputs
          void s.promptDefinition;
        }

        return s.object({});
      },
      render: () => [prompt.user`Ok`],
    });
  });
});
