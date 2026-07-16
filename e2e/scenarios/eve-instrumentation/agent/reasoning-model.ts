import {
  defaultSettingsMiddleware,
  wrapLanguageModel,
  type LanguageModel,
} from "ai";

export function withReadableReasoning(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          openrouter: {
            reasoning: {
              effort: "low",
            },
          },
        },
      },
    }),
    model,
  });
}
