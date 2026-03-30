import { googleGenAIChannels } from "../instrumentation/plugins/google-genai-channels";
import type {
  GoogleGenAIClient,
  GoogleGenAIConstructor,
  GoogleGenAIGenerateContentParams,
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
    console.warn("Invalid Google GenAI module. Not wrapping.");
    return googleGenAI;
  }

  if (!("GoogleGenAI" in googleGenAI)) {
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
  return new Proxy(instance, {
    get(target, prop, receiver) {
      if (prop === "models") {
        return wrapModels(target.models);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
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
