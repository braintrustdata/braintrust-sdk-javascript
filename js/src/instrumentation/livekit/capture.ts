/* eslint-disable @typescript-eslint/no-explicit-any */
import { observe, type Capture } from "./runtime";
import { omit, copyFrame, packet, advance } from "./capture-state";
export { select, release } from "./capture-state";
export { instrumentOutput } from "./playback";
const readers = new WeakMap<object, Capture>();
// Tap the reader already requested by LiveKit. No tee, prefetch, or extra consumer.
// Keeping the original stream lets LiveKit release/reacquire its lock on handoff.
export function instrumentInput(c: Capture, stream: any) {
  if (!c.user || c.closed || !stream?.getReader) return;
  if (c.inputStream && c.inputStream !== stream) {
    omit(c, "input_source_change_unsupported");
    return;
  }
  const previous = readers.get(stream);
  if (previous && previous !== c && !previous.closed) {
    omit(previous, "shared_input_unsupported");
    omit(c, "shared_input_unsupported");
    return;
  }
  c.inputStream = stream;
  readers.set(stream, c);
  const marker = Symbol.for("braintrust.livekit.input");
  if (stream[marker]) return;
  stream[marker] = true;
  const getReader = stream.getReader;
  stream.getReader = function (...args: any[]) {
    const reader: any = Reflect.apply(getReader, this, args);
    const read = reader.read;
    reader.read = async function (...readArgs: any[]) {
      const value: any = await Reflect.apply(read, this, readArgs);
      observe(() => {
        const owner = readers.get(stream);
        if (!owner || owner.closed || value.done) return;
        const frame = value.value;
        const pcm = copyFrame(owner, frame);
        if (!pcm) return;
        const duration = owner.timeline.pcmBytesToMs(
          pcm.byteLength,
          frame.sampleRate,
          frame.channels,
        );
        // This input is an ordered PCM stream, including silent samples. Anchor
        // once to the session epoch; scheduler jitter is not missing audio.
        // Source replacement is rejected above rather than joining unrelated clocks.
        const at =
          owner.inputEnd ?? Math.max(0, Date.now() - owner.origin - duration);
        owner.inputEnd = at + duration;
        if (
          packet(owner, {
            pcm,
            rate: frame.sampleRate,
            channels: frame.channels,
            channel: 0,
            at,
          })
        ) {
          const previous = owner.inputTimeline.at(-1);
          if (
            previous &&
            previous.rate === frame.sampleRate &&
            previous.channels === frame.channels
          )
            previous.duration += duration;
          else
            owner.inputTimeline.push({
              at,
              duration,
              rate: frame.sampleRate,
              channels: frame.channels,
              sampleStart: owner.inputDurationMs,
            });
          owner.inputDurationMs += duration;
          if (owner.inputTimeline.length > 100000)
            omit(owner, "input_alignment_limit");
          advance(owner);
        }
      });
      return value;
    };
    return reader;
  };
}
