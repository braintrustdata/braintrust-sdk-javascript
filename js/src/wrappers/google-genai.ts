import { googleGenAIChannels } from "../instrumentation/plugins/google-genai-channels";
import { isObject } from "../util";
import type {
  GoogleGenAIClient,
  GoogleGenAIConstructor,
  GoogleGenAIEmbedContentParams,
  GoogleGenAIGenerateContentParams,
  GoogleGenAIInteractionCreateParams,
  GoogleGenAIInteractions,
  GoogleGenAIModels,
} from "../vendor-sdk-types/google-genai";

/**
 * Wrap a Google GenAI module (imported with `import * as googleGenAI from '@google/genai'`) to add tracing.
 * If Braintrust is not configured, nothing will be traced.
 *
 * @param googleGenAI The Google GenAI module
 * @returns The wrapped Google GenAI module
 *
 * @example
 * ```typescript
 * import * as googleGenAI from '@google/genai';
 * import { wrapGoogleGenAI, initLogger } from 'braintrust';
 *
 * initLogger({projectName: 'Your project' });
 * const { GoogleGenAI } } = wrapGoogleGenAI(googleGenAI);
 * const client = new GoogleGenAI({ apiKey: 'YOUR_API_KEY' });
 * ```
 */
export function wrapGoogleGenAI<T extends Record<string, any>>(
  googleGenAI: T,
): T {
  if (!googleGenAI || typeof googleGenAI !== "object") {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn("Invalid Google GenAI module. Not wrapping.");
    return googleGenAI;
  }

  if (!("GoogleGenAI" in googleGenAI)) {
    // eslint-disable-next-line no-restricted-properties -- preserving intentional console usage.
    console.warn(
      "GoogleGenAI class not found in module. Not wrapping. Make sure you're passing the module itself (import * as googleGenAI from '@google/genai').",
    );
    return googleGenAI;
  }

  return new Proxy(googleGenAI, {
    get(target, prop, receiver) {
      if (prop === "GoogleGenAI") {
        const OriginalGoogleGenAI = Reflect.get(
          target,
          prop,
          receiver,
        ) as GoogleGenAIConstructor;
        return wrapGoogleGenAIClass(OriginalGoogleGenAI);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapGoogleGenAIClass(
  OriginalGoogleGenAI: GoogleGenAIConstructor,
): GoogleGenAIConstructor {
  return new Proxy(OriginalGoogleGenAI, {
    construct(target, args) {
      const instance = Reflect.construct(target, args);
      return wrapGoogleGenAIInstance(instance as GoogleGenAIClient);
    },
  });
}

function wrapGoogleGenAIInstance(
  instance: GoogleGenAIClient,
): GoogleGenAIClient {
  const wrappedModels = wrapModels(instance.models);
  let originalInteractions: GoogleGenAIInteractions | undefined;
  let wrappedInteractions: GoogleGenAIInteractions | undefined;
  patchGoogleGenAIChats(instance, wrappedModels);

  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop === "models") {
        return wrappedModels;
      }
      if (prop === "interactions") {
        const interactions = Reflect.get(target, prop, receiver) as
          | GoogleGenAIInteractions
          | undefined;
        if (
          !isObject(interactions) ||
          typeof interactions.create !== "function"
        ) {
          return interactions;
        }
        if (interactions !== originalInteractions) {
          originalInteractions = interactions;
          wrappedInteractions = wrapInteractions(interactions);
        }
        return wrappedInteractions;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function patchGoogleGenAIChats(
  instance: GoogleGenAIClient,
  wrappedModels: GoogleGenAIModels,
): void {
  if (!isObject(instance.chats) || !("modelsModule" in instance.chats)) {
    return;
  }

  Reflect.set(instance.chats, "modelsModule", wrappedModels);
}

function wrapModels(models: GoogleGenAIModels): GoogleGenAIModels {
  return new Proxy(models, {
    get(target, prop, receiver) {
      if (prop === "generateContent") {
        return wrapGenerateContent(target.generateContent.bind(target));
      } else if (prop === "generateContentStream") {
        return wrapGenerateContentStream(
          target.generateContentStream.bind(target),
        );
      } else if (prop === "embedContent") {
        return wrapEmbedContent(target.embedContent.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapInteractions(
  interactions: GoogleGenAIInteractions,
): GoogleGenAIInteractions {
  return new Proxy(interactions, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return wrapInteractionCreate(target.create.bind(target));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function wrapGenerateContent(
  original: GoogleGenAIModels["generateContent"],
): GoogleGenAIModels["generateContent"] {
  return function (params: GoogleGenAIGenerateContentParams) {
    return googleGenAIChannels.generateContent.tracePromise(
      () => original(params),
      { arguments: [params] } as Parameters<
        typeof googleGenAIChannels.generateContent.tracePromise
      >[1],
    );
  };
}

function wrapGenerateContentStream(
  original: GoogleGenAIModels["generateContentStream"],
): GoogleGenAIModels["generateContentStream"] {
  return function (params: GoogleGenAIGenerateContentParams) {
    return googleGenAIChannels.generateContentStream.tracePromise(
      () => original(params),
      { arguments: [params] },
    );
  };
}

function wrapEmbedContent(
  original: GoogleGenAIModels["embedContent"],
): GoogleGenAIModels["embedContent"] {
  return function (params: GoogleGenAIEmbedContentParams) {
    return googleGenAIChannels.embedContent.tracePromise(
      () => original(params),
      { arguments: [params] } as Parameters<
        typeof googleGenAIChannels.embedContent.tracePromise
      >[1],
    );
  };
}

function wrapInteractionCreate(
  original: GoogleGenAIInteractions["create"],
): GoogleGenAIInteractions["create"] {
  return function (
    params: GoogleGenAIInteractionCreateParams,
    options?: Record<string, unknown>,
  ) {
    if (params.background === true) {
      return options === undefined
        ? original(params)
        : original(params, options);
    }

    const traceContext =
      options === undefined
        ? { arguments: [params] }
        : { arguments: [params, options] };
    return googleGenAIChannels.interactionsCreate.tracePromise(
      () =>
        options === undefined ? original(params) : original(params, options),
      traceContext as Parameters<
        typeof googleGenAIChannels.interactionsCreate.tracePromise
      >[1],
    );
  };
}
