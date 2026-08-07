import { prompt } from "./experimental-prompt-api";
import type {
  PromptAttachment,
  PromptMessage,
} from "./experimental-prompt-api";

type Extends<T, U> = T extends U ? true : false;
type Equal<T, U> =
  (<V>() => V extends T ? 1 : 2) extends <V>() => V extends U ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const classifierPrompt = prompt.define({
  slug: "typecheck-classifier",
  model: "gpt-4o-mini",
  inputSchema: (s) =>
    s.object({
      text: s.string(),
      count: s.number().optional(),
      mode: s.enum(["brief", "full"]),
      files: s.array(s.attachment()).optional(),
      metadata: s.object({
        urgent: s.boolean(),
      }),
    }),
  outputSchema: (s) =>
    s.object({
      label: s.enum(["bug", "question"]),
      reasons: s.array(s.string()).optional(),
    }),
  template: ({ variables }) => {
    type _TemplateTextIsOpaque = Expect<Equal<typeof variables.text, unknown>>;
    type _NestedTemplateFieldIsVisible = Expect<
      Equal<typeof variables.metadata.urgent, unknown>
    >;
    type _ArrayListTagIsCallable = Expect<
      Extends<
        typeof variables.files.list,
        (
          strings: TemplateStringsArray,
          ...values: readonly unknown[]
        ) => unknown
      >
    >;

    return [
      prompt.user`Classify ${variables.text} as ${variables.mode}.`,
      prompt.user`Urgent: ${variables.metadata.urgent}`,
      prompt.user`Files: ${variables.files.list`- ${variables.files.list}\n`}`,
    ];
  },
});

type ClassifierInput = Parameters<typeof classifierPrompt.build>[0];
type ExpectedClassifierInput = {
  text: string;
  count?: number;
  mode: "brief" | "full";
  files?: PromptAttachment[];
  metadata: {
    urgent: boolean;
  };
};
type _ClassifierInputMatchesExpected = Expect<
  Extends<ClassifierInput, ExpectedClassifierInput>
>;
type _ExpectedMatchesClassifierInput = Expect<
  Extends<ExpectedClassifierInput, ClassifierInput>
>;

const classifierInput: ClassifierInput = {
  text: "The app crashes",
  mode: "brief",
  metadata: { urgent: true },
};

classifierPrompt.build(classifierInput);

classifierPrompt.build({
  text: "The app crashes",
  mode: "full",
  files: ["data:text/plain;base64,aGVsbG8="],
  metadata: { urgent: false },
});

classifierPrompt.build({
  text: "The app crashes",
  // @ts-expect-error enum inputs preserve their literal value set
  mode: "medium",
  metadata: { urgent: true },
});

classifierPrompt.build({
  text: "The app crashes",
  mode: "brief",
  // @ts-expect-error required nested object fields are enforced
  metadata: {},
});

classifierPrompt.build({
  text: "The app crashes",
  mode: "brief",
  metadata: { urgent: true },
  // @ts-expect-error object schemas reject unknown input keys at compile time
  extra: true,
});

const classifierBuilt = classifierPrompt.build(classifierInput);
type _ClassifierKindIsMessages = Expect<
  Equal<typeof classifierBuilt.kind, "messages">
>;
type _ClassifierMessagesArePromptMessages = Expect<
  Equal<typeof classifierBuilt.messages, PromptMessage[]>
>;
type ClassifierParsedOutput = ReturnType<
  NonNullable<typeof classifierBuilt.definition.outputSchema>["parse"]
>;
type _ClassifierOutputMatchesExpected = Expect<
  Extends<
    ClassifierParsedOutput,
    {
      label: "bug" | "question";
      reasons?: string[];
    }
  >
>;

const customAdapterResult = classifierBuilt.to((snapshot) => {
  type _SnapshotInputMatchesPromptInput = Expect<
    Extends<typeof snapshot.input, ExpectedClassifierInput>
  >;
  type _SnapshotOutputMatchesPromptOutput = Expect<
    Extends<
      ReturnType<NonNullable<typeof snapshot.outputSchema>["parse"]>,
      {
        label: "bug" | "question";
        reasons?: string[];
      }
    >
  >;

  if (snapshot.kind === "messages") {
    type _SnapshotMessagesArePromptMessages = Expect<
      Equal<typeof snapshot.messages, PromptMessage[]>
    >;
    // @ts-expect-error message prompt adapter snapshots do not expose content
    void snapshot.content;
  }

  return {
    input: snapshot.input,
    parsedOutput: snapshot.outputSchema?.parse({ label: "bug" }),
  };
});
type _CustomAdapterInputPreservesType = Expect<
  Extends<typeof customAdapterResult.input, ExpectedClassifierInput>
>;
type _CustomAdapterOutputPreservesType = Expect<
  Extends<
    NonNullable<typeof customAdapterResult.parsedOutput>,
    {
      label: "bug" | "question";
      reasons?: string[];
    }
  >
>;
const _customAdapterExtended = customAdapterResult.extend({
  nested: { ok: true },
});
type _CustomAdapterExtendDeepMerges = Expect<
  Equal<typeof _customAdapterExtended.nested.ok, boolean>
>;

const _asyncCustomAdapterResult = classifierBuilt.to(async (snapshot) => ({
  input: snapshot.input,
}));
type _AsyncCustomAdapterReturnsPromise = Expect<
  Extends<
    typeof _asyncCustomAdapterResult,
    Promise<{ input: ExpectedClassifierInput }>
  >
>;

void (async () => {
  const openAIArgs = await classifierBuilt.to(prompt.adapters.openAIChat());
  const extended = openAIArgs.extend({
    temperature: 0.2,
    span_info: {
      metadata: {
        caller: "support-workflow",
      },
    },
  });
  type _OpenAIChatExtendPreservesTemperature = Expect<
    Equal<typeof extended.temperature, number>
  >;
  type _OpenAIChatExtendPreservesCaller = Expect<
    Equal<typeof extended.span_info.metadata.caller, string>
  >;
  type _OpenAIChatExtendPreservesPromptSlug = Expect<
    Equal<typeof extended.span_info.metadata.prompt.root.slug, string>
  >;

  // @ts-expect-error extend only accepts objects
  void extended.extend("nope");
})();

const stringPrompt = prompt.define({
  slug: "typecheck-string",
  inputSchema: (s) =>
    s.object({
      text: s.string(),
    }),
  template: ({ variables }) => prompt.text`Summarize ${variables.text}`,
});

const stringBuilt = stringPrompt.build({ text: "hello" });
type _StringKindIsString = Expect<Equal<typeof stringBuilt.kind, "string">>;
type _StringContentIsString = Expect<Equal<typeof stringBuilt.content, string>>;
// @ts-expect-error string prompts are not iterable message prompts
void [...stringBuilt];

const brandVoicePrompt = prompt.define({
  slug: "typecheck-brand-voice",
  inputSchema: (s) =>
    s.object({
      company: s.string(),
      tone: s.string(),
    }),
  template: ({ variables }) => [
    prompt.system`Use ${variables.company}'s ${variables.tone} voice.`,
  ],
});

const replyPrompt = prompt.define({
  slug: "typecheck-reply",
  inputSchema: (s) =>
    s.object({
      company: s.string(),
      ticket: s.string(),
      voice: s.messagesPromptDefinition(brandVoicePrompt),
    }),
  template: ({ variables }) => [
    ...variables.voice,
    prompt.user`Reply to ${variables.ticket}`,
  ],
});

type ReplyInput = Parameters<typeof replyPrompt.build>[0];
const replyInputWithInheritedCompany: ReplyInput = {
  company: "Braintrust",
  ticket: "Where is my eval?",
  voice: { tone: "direct" },
};
const replyInputWithOverriddenCompany: ReplyInput = {
  company: "Braintrust",
  ticket: "Where is my eval?",
  voice: { company: "Acme", tone: "direct" },
};
const replyInputWithBuiltPrompt: ReplyInput = {
  company: "Braintrust",
  ticket: "Where is my eval?",
  voice: brandVoicePrompt.build({ company: "Braintrust", tone: "direct" }),
};
replyPrompt.build(replyInputWithInheritedCompany);
replyPrompt.build(replyInputWithOverriddenCompany);
replyPrompt.build(replyInputWithBuiltPrompt);

const replyInputMissingNestedField: ReplyInput = {
  company: "Braintrust",
  ticket: "Where is my eval?",
  // @ts-expect-error nested prompt input still needs fields absent from the parent
  voice: {},
};
void replyInputMissingNestedField;

const replyInputWithWrongBuiltPromptKind: ReplyInput = {
  company: "Braintrust",
  ticket: "Where is my eval?",
  // @ts-expect-error string prompts cannot satisfy message prompt fields
  voice: stringBuilt,
};
void replyInputWithWrongBuiltPromptKind;

prompt.define({
  slug: "typecheck-output-helper-scope",
  inputSchema: (s) => s.object({ text: s.string() }),
  outputSchema: (s) =>
    s.object({
      ok: s.boolean(),
      // @ts-expect-error output schema helpers do not expose prompt helpers
      prompt: s.builtMessagesPrompt(),
    }),
  template: ({ variables }) => [prompt.user`${variables.text}`],
});

prompt.define({
  slug: "typecheck-invalid-template-return",
  inputSchema: (s) => s.object({ text: s.string() }),
  // @ts-expect-error templates must return messages or prompt.text
  template: ({ variables }) => prompt.user`${variables.text}`,
});
