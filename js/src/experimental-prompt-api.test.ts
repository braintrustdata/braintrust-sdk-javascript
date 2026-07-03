import { describe, expect, test } from "vitest";
import { prompt, promptDefinitionToMustache } from "./experimental-prompt-api";
import { Attachment, ReadonlyAttachment } from "./logger";

describe("experimental prompt API", () => {
  test("builds message prompts and translates to OpenAI chat args", async () => {
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
      render: ({ variables }) => [
        prompt.system`You write concise support replies.`,
        prompt.user`Ticket: ${variables.ticket}`,
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
    await expect(built.to(prompt.adapters.openAIChat())).resolves.toMatchObject(
      {
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
      },
    );

    if (false) {
      // @ts-expect-error message prompts do not expose string content
      void built.content;
    }
  });

  test("builds string prompts and coerces adapters to a user message", async () => {
    const policyText = prompt.define({
      slug: "policy-text",
      model: "gpt-4o-mini",
      input: (s) =>
        s.object({
          policy: s.string(),
        }),
      render: ({ variables }) => prompt.text`Policy: ${variables.policy}`,
    });

    const built = policyText.build({ policy: "Prefer short answers." });

    expect(built.kind).toBe("string");
    expect(built.content).toBe("Policy: Prefer short answers.");
    expect("messages" in built).toBe(false);
    await expect(built.to(prompt.adapters.openAIChat())).resolves.toMatchObject(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Policy: Prefer short answers." }],
        span_info: {
          metadata: {
            prompt: {
              root: { slug: "policy-text" },
            },
          },
        },
      },
    );
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

  test("exports message prompt data as inlined mustache templates", () => {
    const supportReply = prompt.define({
      slug: "support-reply",
      model: "gpt-4o",
      input: (s) =>
        s.object({
          customer: s.object({
            name: s.string(),
          }),
          ticket: s.string(),
        }),
      output: (s) =>
        s.object({
          body: s.string(),
        }),
      render: ({ variables }) => [
        prompt.system`You write concise support replies.`,
        prompt.user`Customer: ${variables.customer.name}\nTicket: ${variables.ticket}`,
      ],
    });

    const data = supportReply.toPromptData();

    expect(data).toMatchObject({
      slug: "support-reply",
      model: "gpt-4o",
      kind: "messages",
      inputSchema: {
        type: "object",
        required: ["customer", "ticket"],
      },
      outputSchema: {
        type: "object",
        required: ["body"],
      },
      messages: [
        { role: "system", content: "You write concise support replies." },
        {
          role: "user",
          content: "Customer: {{customer.name}}\nTicket: {{ticket}}",
        },
      ],
    });
    expect(promptDefinitionToMustache(data)).toEqual({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You write concise support replies." },
        {
          role: "user",
          content: "Customer: {{customer.name}}\nTicket: {{ticket}}",
        },
      ],
    });
  });

  test("exports string prompt data as a mustache user message template", () => {
    const summarize = prompt.define({
      slug: "summarize",
      model: "gpt-4o-mini",
      input: (s) =>
        s.object({
          text: s.string(),
        }),
      render: ({ variables }) => prompt.text`Summarize: ${variables.text}`,
    });

    const data = summarize.toPromptData();

    expect(data).toMatchObject({
      slug: "summarize",
      model: "gpt-4o-mini",
      kind: "string",
      content: "Summarize: {{text}}",
    });
    expect(promptDefinitionToMustache(data)).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize: {{text}}" }],
    });
  });

  test("inlines nested message prompt definitions in mustache prompt data", () => {
    const brandVoice = prompt.define({
      slug: "brand-voice",
      version: "v3",
      input: (s) =>
        s.object({
          company: s.string(),
          tone: s.string(),
        }),
      render: ({ variables }) => [
        prompt.system`Use ${variables.company}'s ${variables.tone} voice.`,
      ],
    });
    const supportReply = prompt.define({
      slug: "support-reply",
      model: "gpt-4o",
      input: (s) =>
        s.object({
          company: s.string(),
          ticket: s.string(),
          voice: s.messagesPromptDefinition(brandVoice),
        }),
      render: ({ variables }) => [
        ...variables.voice,
        prompt.user`Draft a reply for: ${variables.ticket}`,
      ],
    });

    const data = supportReply.toPromptData();

    expect(data.kind).toBe("messages");
    expect(data.messages).toEqual([
      {
        role: "system",
        content: "Use {{company}}'s {{voice.tone}} voice.",
      },
      { role: "user", content: "Draft a reply for: {{ticket}}" },
    ]);
    expect(data.dependencies.prompts).toMatchObject([
      { slug: "support-reply", role: "root" },
      {
        slug: "brand-voice",
        version: "v3",
        role: "include",
        parent: "support-reply",
      },
    ]);
  });

  test("inlines nested string prompt definitions in mustache prompt data", () => {
    const policyText = prompt.define({
      slug: "policy-text",
      version: "v2",
      input: (s) =>
        s.object({
          company: s.string(),
          text: s.string(),
        }),
      render: ({ variables }) =>
        prompt.text`${variables.company}: ${variables.text}`,
    });
    const supportReply = prompt.define({
      slug: "support-reply",
      model: "gpt-4o",
      input: (s) =>
        s.object({
          company: s.string(),
          ticket: s.string(),
          policy: s.stringPromptDefinition(policyText),
        }),
      render: ({ variables }) => [
        prompt.system`Follow this policy: ${variables.policy}`,
        prompt.user`Draft a reply for: ${variables.ticket}`,
      ],
    });

    const data = supportReply.toPromptData();

    expect(data.kind).toBe("messages");
    expect(data.messages).toEqual([
      {
        role: "system",
        content: "Follow this policy: {{company}}: {{policy.text}}",
      },
      { role: "user", content: "Draft a reply for: {{ticket}}" },
    ]);
    expect(data.dependencies.prompts).toMatchObject([
      { slug: "support-reply", role: "root" },
      {
        slug: "policy-text",
        version: "v2",
        role: "include",
        parent: "support-reply",
      },
    ]);
  });

  test("promptDefinitionToMustache requires a model", () => {
    const modeless = prompt.define({
      slug: "modeless",
      input: (s) => s.object({ text: s.string() }),
      render: ({ variables }) => [prompt.user`Say ${variables.text}`],
    });

    expect(() => promptDefinitionToMustache(modeless.toPromptData())).toThrow(
      "Cannot convert prompt data to mustache without a model",
    );
  });

  test("exports array list templates as mustache sections", () => {
    const itemList = prompt.define({
      slug: "item-list",
      model: "gpt-4o",
      input: (s) =>
        s.object({
          items: s.array(
            s.object({
              foobar: s.string(),
              author: s.object({
                name: s.string(),
              }),
            }),
          ),
        }),
      render: ({ variables }) => [
        prompt.user`Items:\n${variables.items.list`- ${variables.items.list.foobar} by ${variables.items.list.author.name}\n`}`,
      ],
    });

    const built = itemList.build({
      items: [
        { foobar: "first", author: { name: "Ada" } },
        { foobar: "second", author: { name: "Grace" } },
      ],
    });
    const data = itemList.toPromptData();

    expect(built.messages).toEqual([
      {
        role: "user",
        content: "Items:\n- first by Ada\n- second by Grace\n",
      },
    ]);
    expect(data.kind).toBe("messages");
    expect(data.messages).toEqual([
      {
        role: "user",
        content:
          "Items:\n{{#items}}- {{foobar}} by {{author.name}}\n{{/items}}",
      },
    ]);
    expect(promptDefinitionToMustache(data)).toEqual({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content:
            "Items:\n{{#items}}- {{foobar}} by {{author.name}}\n{{/items}}",
        },
      ],
    });
  });

  test("passes parsed runtime values separately from template variables", () => {
    const itemSummary = prompt.define({
      slug: "item-summary",
      input: (s) =>
        s.object({
          items: s.array(
            s.object({
              foobar: s.string(),
            }),
          ),
        }),
      render: ({ values }) => [
        prompt.user`Second: ${values.items[1]?.foobar}\nAll: ${values.items.map((item) => item.foobar).join(", ")}`,
      ],
    });

    expect(
      itemSummary.build({
        items: [{ foobar: "first" }, { foobar: "second" }],
      }).messages,
    ).toEqual([
      {
        role: "user",
        content: "Second: second\nAll: first, second",
      },
    ]);
    expect(() => itemSummary.toPromptData()).toThrow(
      "Runtime values are not available while exporting prompt data; use variables in prompt templates.",
    );
  });

  test("converts prompt.file parts for OpenAI and AI SDK adapters", async () => {
    const imageDataUrl = "data:image/png;base64,aW1hZ2U=";
    const pdfDataUrl = "data:application/pdf;base64,cGRm";
    const describeFiles = prompt.define({
      slug: "describe-files",
      model: "gpt-4o",
      input: (s) =>
        s.object({
          image: s.attachment(),
          document: s.attachment(),
          gallery: s.array(s.attachment()),
        }),
      render: ({ variables, values }) => [
        prompt.user([
          prompt.text`Describe these files.`,
          prompt.file(variables.image),
          prompt.file(variables.document, { filename: "brief.pdf" }),
          ...values.gallery.map((item) => prompt.file(item)),
        ]),
      ],
    });

    const built = describeFiles.build({
      image: imageDataUrl,
      document: pdfDataUrl,
      gallery: [
        "https://example.com/first.png",
        "https://example.com/second.jpg",
      ],
    });
    const openAIArgs = await built.to(prompt.adapters.openAIChat());
    const aiSDKArgs = await built.to(prompt.adapters.aiSDKGenerateObject());

    expect(openAIArgs.messages[0]?.content).toEqual([
      { type: "text", text: "Describe these files." },
      { type: "image_url", image_url: { url: imageDataUrl } },
      {
        type: "file",
        file: { file_data: pdfDataUrl, filename: "brief.pdf" },
      },
      {
        type: "image_url",
        image_url: { url: "https://example.com/first.png" },
      },
      {
        type: "image_url",
        image_url: { url: "https://example.com/second.jpg" },
      },
    ]);
    expect(aiSDKArgs.messages[0]?.content).toEqual([
      { type: "text", text: "Describe these files." },
      { type: "image", image: imageDataUrl, mediaType: "image/png" },
      {
        type: "file",
        data: pdfDataUrl,
        mediaType: "application/pdf",
        filename: "brief.pdf",
      },
      {
        type: "image",
        image: "https://example.com/first.png",
        mediaType: "image/png",
      },
      {
        type: "image",
        image: "https://example.com/second.jpg",
        mediaType: "image/jpeg",
      },
    ]);
  });

  test("resolves Attachment and ReadonlyAttachment values without leaking bytes", async () => {
    const attachment = new Attachment({
      data: new Blob(["hello"], { type: "text/plain" }),
      filename: "hello.txt",
      contentType: "text/plain",
    });
    const readonly = new ReadonlyAttachment({
      type: "external_attachment",
      url: "https://example.com/doc.pdf",
      filename: "doc.pdf",
      content_type: "application/pdf",
    });
    readonly.asBase64Url = async () => "data:application/pdf;base64,cGRm";
    const describeFiles = prompt.define({
      slug: "describe-uploaded-files",
      model: "gpt-4o",
      input: (s) =>
        s.object({
          attachment: s.attachment(),
          readonly: s.attachment(),
        }),
      render: ({ variables }) => [
        prompt.user([
          prompt.text`Describe these uploads.`,
          prompt.file(variables.attachment),
          prompt.file(variables.readonly),
        ]),
      ],
    });

    const built = describeFiles.build({ attachment, readonly });
    const args = await built.to(prompt.adapters.openAIChat());

    expect(args.messages[0]?.content).toEqual([
      { type: "text", text: "Describe these uploads." },
      {
        type: "file",
        file: {
          file_data: "data:text/plain;base64,aGVsbG8=",
          filename: "hello.txt",
        },
      },
      {
        type: "file",
        file: {
          file_data: "data:application/pdf;base64,cGRm",
          filename: "doc.pdf",
        },
      },
    ]);
    expect(JSON.stringify(built.dependencies.prompts[0]?.input)).not.toContain(
      "aGVsbG8=",
    );
    expect(built.dependencies.prompts[0]?.input).toMatchObject({
      attachment: {
        type: "attachment",
        reference: {
          type: "braintrust_attachment",
          filename: "hello.txt",
          content_type: "text/plain",
        },
      },
      readonly: {
        type: "attachment",
        reference: {
          type: "external_attachment",
          filename: "doc.pdf",
          content_type: "application/pdf",
        },
      },
    });
  });

  test("rejects rich media content outside user messages", () => {
    const invalid = prompt.define({
      slug: "invalid-media-role",
      input: (s) => s.object({}),
      render: () => [
        {
          role: "system" as const,
          content: [prompt.file("https://example.com/image.png")],
        },
      ],
    });

    expect(() => invalid.build({})).toThrow(
      "render[0] must be a prompt message",
    );
  });

  test("extends adapter args with a typed deep merge", async () => {
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
      render: ({ variables }) => [prompt.user`Classify: ${variables.text}`],
    });

    const built = classify.build({ text: "It crashes" });
    const args = await built.to(prompt.adapters.openAIChat());
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

      void (async () => {
        const typedArgs = (await built.to(prompt.adapters.openAIChat())).extend(
          {
            temperature: 0.2,
            span_info: {
              metadata: {
                caller: "support-workflow",
              },
            },
          },
        );
        const temperature: number = typedArgs.temperature;
        const caller: string = typedArgs.span_info.metadata.caller;
        const slug: string = typedArgs.span_info.metadata.prompt.root.slug;
        void temperature;
        void caller;
        void slug;

        // @ts-expect-error extend only accepts objects
        void typedArgs.extend("nope");
      });
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
      render: ({ variables }) => [
        prompt.system`Use ${variables.company}'s ${variables.tone} voice.`,
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
      render: ({ variables }) => [
        ...variables.voice,
        prompt.user`Draft a reply for: ${variables.ticket}`,
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
      render: ({ variables }) =>
        prompt.text`${variables.company}: ${variables.policy}`,
    });

    const supportReply = prompt.define({
      slug: "support-reply",
      input: (s) =>
        s.object({
          company: s.string(),
          ticket: s.string(),
          policy: s.stringPromptDefinition(policyText),
        }),
      render: ({ variables }) => [
        prompt.system`Follow this policy: ${variables.policy}`,
        prompt.user`Draft a reply for: ${variables.ticket}`,
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
      render: ({ variables }) => [
        prompt.user`Message about ${variables.topic}`,
      ],
    });
    const stringPrompt = prompt.define({
      slug: "string-prompt",
      input: (s) =>
        s.object({
          topic: s.string(),
        }),
      render: ({ variables }) => prompt.text`String about ${variables.topic}`,
    });

    const consumeBoth = prompt.define({
      slug: "consume-both",
      input: (s) =>
        s.object({
          messagePart: s.builtMessagesPrompt(),
          stringPart: s.builtStringPrompt(),
        }),
      render: ({ variables }) => [
        ...variables.messagePart,
        prompt.user`Fragment: ${variables.stringPart}`,
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
      render: ({ variables }) => [
        prompt.user`Message about ${variables.topic}`,
      ],
    });
    const stringPrompt = prompt.define({
      slug: "string-prompt",
      input: (s) =>
        s.object({
          topic: s.string(),
        }),
      render: ({ variables }) => prompt.text`String about ${variables.topic}`,
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
      render: ({ variables }) => [prompt.user`Count: ${variables.count}`],
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
      render: ({ variables }) => [prompt.user`Topic: ${variables.topic}`],
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
      render: ({ variables }) => [prompt.user`Classify: ${variables.text}`],
    });
    const summarize = prompt.define({
      slug: "summarize",
      input: (s) =>
        s.object({
          text: s.string(),
        }),
      render: ({ variables }) => prompt.text`Summarize: ${variables.text}`,
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
        expect("attachment" in s).toBe(true);
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
          // @ts-expect-error rich content is only supported by prompt.user
          void prompt.system([prompt.file("https://example.com/image.png")]);
        }

        return s.object({});
      },
      render: () => [prompt.user`Ok`],
    });
  });
});
