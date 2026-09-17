/**
 * Speech-native turns through an OpenAI-compatible endpoint.
 *
 * One model call per turn: audio in, audio out, plus the transcript of what it
 * said. Both an actor and an agent under test can be built on this, which is
 * what makes a voice-to-voice call possible with no speech vendors, no
 * telephony and no framework.
 */

import { AudioFrame } from "./types";

/** A WAV container in, a WAV container out. */
export interface SpeechOptions {
  /** An OpenAI-compatible chat completions endpoint. */
  baseUrl?: string;
  apiKey?: string;
  /** A model that accepts and emits audio. */
  model?: string;
  /** Which voice it speaks in. */
  voice?: string;
  /** Tools it may call, in OpenAI function-tool shape. */
  tools?: unknown[];
  /**
   * Ceiling on one turn's output.
   *
   * Spoken audio costs far more tokens than the same words as text, so the
   * default ceiling is generous. A turn that hits it fails outright rather
   * than truncating, which reads as a broken call.
   */
  maxTokens?: number;
  /**
   * How many times to retry a turn the far side could not serve.
   *
   * A call is many model calls in sequence, so a single rate limit or gateway
   * hiccup otherwise ends the whole conversation. Prior art warns that audio
   * endpoints degrade under burst load, which is exactly when this bites.
   */
  retries?: number;
}

export interface SpeechTurn {
  text: string;
  wav: Uint8Array | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

export const DEFAULT_SPEECH_MODEL = "gpt-audio";

function resolve(options: SpeechOptions) {
  const apiKey = options.apiKey ?? process.env.BRAINTRUST_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Speaking needs an API key. Set BRAINTRUST_API_KEY, or pass apiKey.",
    );
  }
  return {
    apiKey,
    baseUrl: options.baseUrl ?? "https://api.braintrust.dev/v1/proxy",
    model: options.model ?? DEFAULT_SPEECH_MODEL,
    voice: options.voice ?? "alloy",
  };
}

/** Wrap a WAV as a content part the model can hear. */
export function heard(wav: Uint8Array): unknown {
  return {
    type: "input_audio",
    input_audio: { data: Buffer.from(wav).toString("base64"), format: "wav" },
  };
}

/**
 * Take one speaking turn.
 *
 * Returns no audio when the model chose to call a tool instead of speaking,
 * which is a normal outcome: feed the tool results back and call again.
 */
export async function speak(
  messages: unknown[],
  options: SpeechOptions = {},
): Promise<SpeechTurn> {
  const { apiKey, baseUrl, model, voice } = resolve(options);
  const attempts = (options.retries ?? 2) + 1;
  let response: Response | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        modalities: ["text", "audio"],
        audio: { voice, format: "wav" },
        max_completion_tokens: options.maxTokens ?? 4096,
        ...(options.tools?.length ? { tools: options.tools } : {}),
        messages,
      }),
    });
    if (response.ok) break;
    // A rate limit or a gateway error is worth another go; a bad request is
    // not, because it will be just as bad next time.
    const worthRetrying = response.status === 429 || response.status >= 500;
    if (!worthRetrying || attempt === attempts) {
      throw new Error(
        `Speech call failed: ${response.status} ${await response.text()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }

  const body = (await response!.json()) as any;
  const message = body?.choices?.[0]?.message ?? {};
  const audio = message.audio ?? {};
  return {
    text: audio.transcript ?? message.content ?? "",
    wav: audio.data ? new Uint8Array(Buffer.from(audio.data, "base64")) : null,
    toolCalls: (message.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "{}",
    })),
  };
}

/** Read a WAV's PCM back out, so it can travel as an `AudioFrame`. */
export function wavToFrame(wav: Uint8Array): AudioFrame {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  // Walk the chunks rather than assuming data starts at 44: some encoders put
  // a LIST or fact chunk in front of it.
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = String.fromCharCode(...wav.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const bytes = wav.slice(offset + 8, offset + 8 + size);
      const copy = new Uint8Array(bytes);
      return {
        data: new Int16Array(copy.buffer, 0, Math.floor(copy.byteLength / 2)),
        sampleRate,
        numChannels,
      };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("No data chunk in WAV.");
}
