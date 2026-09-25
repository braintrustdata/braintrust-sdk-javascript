/** Experimental, explicitly attached protocol instrumentation. Not global ws patching. */
import { Attachment, type Span } from "../../logger";

type Event = Record<string, any>; // Protocol JSON is validated at the observed boundaries.
type Mapping = { modelStart: number; modelEnd: number; callStart: number };
type Segment = { start: number; end: number; chunks: Buffer[]; parent: Span };

/** Convert G.711 mu-law to a self-describing PCM16 WAV, preserving sample count. */
function wav(chunks: Buffer[]) {
  const ulaw = Buffer.concat(chunks);
  const result = Buffer.alloc(44 + ulaw.length * 2);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24);
  result.writeUInt32LE(16000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(ulaw.length * 2, 40);
  for (let i = 0; i < ulaw.length; i++) {
    const u = ~ulaw[i] & 255;
    const magnitude = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
    result.writeInt16LE(
      u & 128 ? 132 - magnitude : magnitude - 132,
      44 + i * 2,
    );
  }
  return result;
}

/**
 * Observe one 8 kHz mono PCMU Twilio <Connect><Stream> / OpenAI Realtime bridge.
 * Call before installing application listeners. The application must forward input
 * unchanged and pace output. We record transport evidence, never infer playback.
 * Explicit socket registration is necessary: a generic ws hook cannot identify
 * which two connections belong to the same call or which application owns pacing.
 */
export function createVoiceRecorder({
  span,
  retainAudio = false,
  now = () => performance.now(),
  segmentMs = 5000,
  maxAudioBytes = 8_000 * 60 * 5,
  outputClock = "sender.paced_queue_estimate",
  allowInputGaps = false,
}: {
  span: Span;
  retainAudio?: boolean;
  now?: () => number;
  segmentMs?: number;
  maxAudioBytes?: number;
  outputClock?: string;
  allowInputGaps?: boolean;
}) {
  const started = now();
  let active = true;
  let stream = "stream";
  let inputEnd: number | undefined;
  let modelMs = 0;
  let retainedBytes = 0;
  let limitReported = false;
  let clockAnchor: { call: number; observed: number } | undefined;
  const pendingInput: { payload: string; start: number; end: number }[] = [];
  const mappings: Mapping[] = [];
  const segments = new Map<string, Segment>();
  const voices = new Map<string, Span>();
  const responses = new Map<string, Span>();
  let currentResponse: Span | undefined;
  let agentVoice: Span | undefined;
  let agentEnd: number | undefined;
  let outputEnd: number | undefined;

  const observed = () => now() - started;
  const callNow = () =>
    clockAnchor ? clockAnchor.call + now() - clockAnchor.observed : observed();
  function marker(name: string, metadata: Record<string, unknown> = {}) {
    const child = span.startSpan({ name, event: { metadata } });
    child.end();
  }
  function flush(track: string) {
    const segment = segments.get(track);
    if (!segment) return;
    segments.delete(track);
    const input = track === "caller";
    const metadata: Record<string, unknown> = {
      "audio.track.id": `${stream}:${track}`,
      "audio.start_offset_ms": segment.start,
      "audio.end_offset_ms": segment.end,
      "audio.scope": "segment",
      "audio.capture": input ? "input" : "sent",
      "audio.clock.source": input ? "twilio.media.timestamp" : outputClock,
    };
    const child = segment.parent.startSpan({
      name: input ? "user_audio" : "agent_audio",
    });
    if (segment.chunks.length) {
      const bytes = wav(segment.chunks);
      metadata["audio.ref"] = "input.audio";
      child.log({
        input: {
          audio: new Attachment({
            data: new Blob([new Uint8Array(bytes)]),
            filename: `${track}-${segment.start}.wav`,
            contentType: "audio/wav",
          }),
        },
      });
    }
    child.log({ metadata });
    child.end();
  }
  function add(track: string, start: number, bytes: Buffer, parent: Span) {
    const previous = segments.get(track);
    // Only coalesce contiguous sample ranges. Gaps must remain visible.
    if (
      previous &&
      (Math.abs(previous.end - start) > 0.01 ||
        previous.parent !== parent ||
        previous.end - previous.start >= segmentMs)
    )
      flush(track);
    const segment = segments.get(track) ?? {
      start,
      end: start,
      chunks: [],
      parent,
    };
    const end = start + bytes.length / 8;
    segment.end = end;
    if (retainAudio && retainedBytes + bytes.length <= maxAudioBytes) {
      segment.chunks.push(Buffer.from(bytes));
      retainedBytes += bytes.length;
    } else if (retainAudio) {
      // Drop this whole segment's bytes, not just its tail: timing must match attachments.
      segment.chunks = [];
      if (!limitReported) {
        marker("audio.retention.limit", { limit_bytes: maxAudioBytes });
        limitReported = true;
      }
    }
    // Once retention is exhausted, don't attach later partial segments.
    if (limitReported) segment.chunks = [];
    segments.set(track, segment);
    return end;
  }
  function mapTime(ms: number, end = false) {
    const range = mappings.find((m) =>
      end
        ? ms > m.modelStart && ms <= m.modelEnd
        : ms >= m.modelStart && ms < m.modelEnd,
    );
    if (range) return range.callStart + ms - range.modelStart;
    if (ms === 0) return mappings[0]?.callStart;
    const last = mappings.at(-1);
    return last && ms === last.modelEnd
      ? last.callStart + ms - last.modelStart
      : undefined;
  }
  function finishAgent() {
    flush("agent");
    if (agentVoice) {
      if (agentEnd !== undefined)
        agentVoice.log({ metadata: { "voice.end_offset_ms": agentEnd } });
      agentVoice.end();
      agentVoice = undefined;
    }
    agentEnd = undefined;
  }
  function incoming(e: Event) {
    if (e.event === "start") {
      const f = e.start?.mediaFormat;
      if (
        f?.encoding !== "audio/x-mulaw" ||
        Number(f.sampleRate) !== 8000 ||
        Number(f.channels) !== 1
      )
        throw new Error("Expected Twilio mono PCMU at 8 kHz");
      stream = e.start.streamSid ?? e.streamSid;
    }
    if (e.event === "media" && e.media?.track === "inbound") {
      const start = Number(e.media.timestamp);
      const bytes = Buffer.from(e.media.payload, "base64");
      if (!Number.isFinite(start) || start < 0 || !bytes.length)
        throw new Error("Invalid inbound media");
      if (!clockAnchor) {
        clockAnchor = { call: start, observed: now() };
        span.log({
          metadata: { "audio.timeline.start_time_unix_ms": Date.now() - start },
        });
      }
      if (inputEnd !== undefined && start < inputEnd - 0.01)
        throw new Error("Overlapping or out-of-order inbound media");
      if (inputEnd !== undefined && start > inputEnd + 0.01)
        marker("audio.capture.gap", {
          "audio.track.id": `${stream}:caller`,
          "audio.start_offset_ms": inputEnd,
          "audio.end_offset_ms": start,
        });
      inputEnd = add("caller", start, bytes, span);
      pendingInput.push({ payload: e.media.payload, start, end: inputEnd });
    }
    if (e.event === "mark")
      marker("audio.buffer.mark_received", {
        "audio.track.id": `${stream}:agent`,
        mark: e.mark?.name,
      });
  }
  function modelSend(e: Event) {
    if (e.type === "input_audio_buffer.append") {
      const frame = pendingInput.shift();
      if (allowInputGaps && (!frame || frame.payload !== e.audio)) {
        // The stock adapter may insert silence for input inactivity. Advance the
        // model clock, but don't invent a call-time mapping for synthetic samples.
        if (frame) pendingInput.unshift(frame);
        modelMs += Buffer.from(e.audio, "base64").length / 8;
        return;
      }
      if (!frame || frame.payload !== e.audio)
        throw new Error(
          "Bridge input must be forwarded unchanged and in order",
        );
      const duration = frame.end - frame.start;
      const previous = mappings.at(-1);
      if (
        previous &&
        Math.abs(
          previous.callStart +
            previous.modelEnd -
            previous.modelStart -
            frame.start,
        ) < 0.01
      )
        previous.modelEnd += duration;
      else
        mappings.push({
          modelStart: modelMs,
          modelEnd: modelMs + duration,
          callStart: frame.start,
        });
      modelMs += duration;
    }
    if (e.type === "conversation.item.truncate")
      marker("audio.truncate.request", {
        item_id: e.item_id,
        requested_audio_end_ms: e.audio_end_ms,
      });
  }
  function modelReceive(e: Event) {
    if (e.type === "response.created") {
      const response = span.startSpan({
        name: "realtime_response",
        event: { metadata: { response_id: e.response.id } },
      });
      responses.set(e.response.id, response);
    }
    if (e.type === "response.output_audio.delta") {
      const response = responses.get(e.response_id);
      if (response && response !== currentResponse) {
        finishAgent();
        currentResponse = response;
      }
    }
    if (e.type === "input_audio_buffer.speech_started") {
      const offset = mapTime(e.audio_start_ms);
      const voice = span.startSpan({
        name: "user_speaking",
        event: {
          metadata: {
            "audio.track.id": `${stream}:caller`,
            "voice.role": "user",
            "voice.basis": "vad",
            item_id: e.item_id,
            ...(offset !== undefined
              ? { "voice.start_offset_ms": offset }
              : {}),
          },
        },
      });
      voices.set(e.item_id, voice);
    }
    if (e.type === "input_audio_buffer.speech_stopped") {
      const offset = mapTime(e.audio_end_ms, true);
      const voice = voices.get(e.item_id);
      if (offset !== undefined)
        voice?.log({ metadata: { "voice.end_offset_ms": offset } });
      voice?.end();
    }
    if (e.type === "conversation.item.input_audio_transcription.completed") {
      voices
        .get(e.item_id)
        ?.log({ input: [{ role: "user", content: e.transcript }] });
    }
    if (e.type === "response.output_audio_transcript.done") {
      responses.get(e.response_id)?.log({
        output: [{ role: "assistant", content: e.transcript }],
        metadata: {
          "transcript.scope": "generated; may include unsent or unplayed words",
        },
      });
    }
    if (e.type === "response.done") {
      const response = responses.get(e.response.id);
      response?.log({
        metadata: { status: e.response.status, usage: e.response.usage },
      });
      // Response completion is inference completion, not audio playback completion.
      response?.end();
    }
    if (e.type === "error")
      marker("realtime.error", {
        code: e.error?.code,
        message: e.error?.message,
      });
  }
  function outgoing(e: Event) {
    if (e.event === "media") {
      const bytes = Buffer.from(e.media.payload, "base64");
      if (!clockAnchor)
        throw new Error(
          "Cannot map output before first inbound media timestamp",
        );
      // Pacing makes this a sender-side media clock. It still excludes network/device latency.
      const observedStart = Math.round(callNow() * 8) / 8;
      const start =
        outputEnd !== undefined && Math.abs(observedStart - outputEnd) <= 40
          ? outputEnd
          : Math.max(outputEnd ?? 0, observedStart);
      if (!agentVoice) {
        agentVoice = (currentResponse ?? span).startSpan({
          name: "agent_speaking",
          event: {
            metadata: {
              "audio.track.id": `${stream}:agent`,
              "voice.role": "assistant",
              "voice.basis": "transport",
              "voice.start_offset_ms": start,
            },
          },
        });
        currentResponse?.log({
          metadata: { "voice.span_id": agentVoice.spanId },
        });
      }
      outputEnd = add("agent", start, bytes, agentVoice);
      agentEnd = outputEnd;
    }
    if (e.event === "clear") {
      finishAgent();
      outputEnd = undefined;
      marker("audio.clear.request", {
        "audio.track.id": `${stream}:agent`,
        "audio.start_offset_ms": callNow(),
      });
    }
  }
  function safe(handler: (e: Event) => void, data: any) {
    if (!active) return;
    try {
      handler(
        typeof data === "string" || Buffer.isBuffer(data)
          ? JSON.parse(data.toString())
          : data,
      );
    } catch (error) {
      marker("audio.instrumentation.error", {
        message: error instanceof Error ? error.message : String(error),
      });
      // Do not break the customer's sockets. Stop collecting invalid timing.
      active = false;
    }
  }
  let finished = false;
  return {
    incoming: (event: Event) => safe(incoming, event),
    outgoing: (event: Event) => safe(outgoing, event),
    modelSend: (event: Event) => safe(modelSend, event),
    modelReceive: (event: Event) => safe(modelReceive, event),
    resetPendingInput: () => {
      pendingInput.length = 0;
    },
    finish() {
      if (finished) return;
      finished = true;
      active = false;
      flush("caller");
      finishAgent();
      for (const voice of voices.values()) voice.end();
      for (const response of responses.values()) response.end();
      pendingInput.length = 0;
    },
  };
}
