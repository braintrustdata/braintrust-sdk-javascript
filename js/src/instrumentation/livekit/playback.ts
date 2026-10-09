/* eslint-disable @typescript-eslint/no-explicit-any */
import { nativeId, observe, type Capture, type Packet } from "./runtime";
import { omit, copyFrame, packet, advance, select } from "./capture-state";
const MAX_PACKETS = 100000;
const outputs = new WeakMap<object, Capture>();
type PlaybackRun = {
  frames: Packet[];
  duration: number;
  owner?: string;
  speaking?: string;
  unclaimed: { start: number; end: number }[];
  started?: number;
  ranges: { offset: number; duration: number; startedAt: number }[];
  finished?: any;
  inFlight: number;
  hold: number;
  processed: number;
  hadProgress: boolean;
};
export function instrumentOutput(
  c: Capture,
  sink: any,
  captureContent: boolean,
) {
  if (!c.agent || c.closed || !sink?.captureFrame || !sink.on) return;
  if (outputs.get(sink) === c) return;
  const previous = outputs.get(sink);
  if (previous) {
    if (!previous.closed) omit(previous, "shared_output_unsupported");
    omit(c, "shared_output_unsupported");
    return;
  }
  outputs.set(sink, c);
  let current: PlaybackRun | undefined;
  const segments: PlaybackRun[] = [];
  function settle(segment: PlaybackRun) {
    if (segment.inFlight || (!segment.finished && !segment.ranges.length))
      return;
    const index = segments.indexOf(segment);
    if (index < 0) return;
    const finishing = !!segment.finished;
    if (finishing) {
      segments.splice(index, 1);
      if (current === segment) current = undefined;
    }
    if (c.closed || c.recording.reason) {
      for (const frame of segment.frames) c.recording.release(frame.pcm);
      segment.frames = [];
      c.outputHolds.delete(segment);
      return;
    }
    segment.speaking ??= nativeId(c.session.agentSpeakingSpan);
    const ev = segment.finished;
    const ranges = segment.ranges.splice(0);
    if (
      finishing &&
      !segment.hadProgress &&
      segment.started !== undefined &&
      !ev.interrupted
    )
      ranges.push({
        startedAt: segment.started,
        offset: 0,
        duration: Math.min(segment.duration, ev.playbackPosition * 1000),
      });
    if (
      finishing &&
      !ranges.length &&
      !segment.hadProgress &&
      segment.duration
    ) {
      omit(c, "output_playout_mapping_unavailable");
      for (const f of segment.frames) c.recording.release(f.pcm);
      segment.frames = [];
      c.outputHolds.delete(segment);
      return;
    }
    const moved = new Set<ArrayBufferLike>();
    for (const range of ranges) {
      if (
        ![range.startedAt, range.offset, range.duration].every(
          Number.isFinite,
        ) ||
        range.offset < segment.processed - c.timeline.samplesToMs(1) ||
        range.duration < 0
      ) {
        omit(c, "invalid_playout_range");
        break;
      }
      const end = range.offset + range.duration;
      for (const frame of segment.frames) {
        const duration = c.timeline.pcmBytesToMs(
          frame.pcm.byteLength,
          frame.rate,
          frame.channels,
        );
        const from = Math.max(frame.at, range.offset),
          to = Math.min(frame.at + duration, end);
        if (to <= from) continue;
        const lo =
          Math.round(c.timeline.msToSamples(from - frame.at, frame.rate)) *
          frame.channels;
        const hi =
          Math.round(c.timeline.msToSamples(to - frame.at, frame.rate)) *
          frame.channels;
        const at = Math.max(
          0,
          range.startedAt - c.origin + from - range.offset,
        );
        const pcm = frame.pcm.subarray(lo, hi);
        const whole = lo === 0 && hi === frame.pcm.length;
        if (whole) moved.add(frame.pcm.buffer);
        const accepted = whole
          ? packet(c, { ...frame, pcm, at })
          : c.recording.record({ ...frame, pcm, at });
        if (accepted) {
          select(
            c,
            segment.owner,
            at,
            at +
              c.timeline.pcmBytesToMs(
                pcm.byteLength,
                frame.rate,
                frame.channels,
              ),
            1,
          );
          const end =
            at +
            c.timeline.pcmBytesToMs(pcm.byteLength, frame.rate, frame.channels);
          const previous = segment.unclaimed.at(-1);
          if (
            previous &&
            at >= previous.start &&
            at <= previous.end + c.timeline.samplesToMs(1)
          )
            previous.end = Math.max(previous.end, end);
          else if (segment.unclaimed.length < MAX_PACKETS)
            segment.unclaimed.push({ start: at, end });
          else omit(c, "selection_limit");
        }
      }
      segment.processed = end;
      // Only confirmed output advances this hold. Generated/queued audio never does.
      segment.hold = Math.max(0, range.startedAt - c.origin + range.duration);
      c.outputHolds.set(segment, segment.hold);
    }
    if (segment.speaking)
      for (const range of segment.unclaimed.splice(0))
        select(c, segment.speaking, range.start, range.end, 1);
    segment.frames = segment.frames.filter((frame) => {
      const consumed =
        finishing ||
        c.recording.reason ||
        frame.at +
          c.timeline.pcmBytesToMs(
            frame.pcm.byteLength,
            frame.rate,
            frame.channels,
          ) <=
          segment.processed + c.timeline.samplesToMs(1);
      if (consumed && !moved.has(frame.pcm.buffer))
        c.recording.release(frame.pcm);
      return !consumed;
    });
    if (finishing) {
      c.outputHolds.delete(segment);
      if (segment.owner) {
        const events = c.events.get(segment.owner) ?? [];
        if (events.length < 256)
          events.push({
            name: "playbackFinished",
            time_unix_ms: Date.now(),
            attributes: {
              playbackPosition: ev.playbackPosition,
              interrupted: ev.interrupted,
              ...(captureContent && ev.synchronizedTranscript !== undefined
                ? { synchronizedTranscript: ev.synchronizedTranscript }
                : {}),
            },
          });
        c.events.set(segment.owner, events);
      }
      c.publishSelections?.();
    }
    advance(c);
  }
  const started = (ev: any) =>
    observe(() => {
      const s = segments[0];
      if (s) s.started = ev.createdAt;
    });
  const progressed = (ev: any) =>
    observe(() => {
      const s = segments[0];
      if (s && s.ranges.length < MAX_PACKETS) {
        s.hadProgress = true;
        s.ranges.push({
          startedAt: ev.startedAt,
          offset: ev.offset,
          duration: ev.duration,
        });
        settle(s);
      } else if (s) omit(c, "playout_range_limit");
    });
  const finished = (ev: any) =>
    observe(() => {
      const s = segments.find((s) => !s.finished);
      if (s) {
        s.finished = ev;
        settle(s);
      }
    });
  sink.on("playbackStarted", started);
  sink.on("playbackProgressed", progressed);
  sink.on("playbackFinished", finished);
  c.cleanups.push(() => {
    sink.off?.("playbackStarted", started);
    sink.off?.("playbackProgressed", progressed);
    sink.off?.("playbackFinished", finished);
    if (segments.some((s) => s.frames.length))
      omit(c, "unfinished_output_segment");
    for (const segment of segments)
      for (const frame of segment.frames) c.recording.release(frame.pcm);
    segments.splice(0);
    c.outputHolds.clear();
    current = undefined;
  });
  const captureFrame = sink.captureFrame;
  sink.captureFrame = async function (frame: any, ...args: any[]) {
    let segment: PlaybackRun | undefined;
    let pcm: Int16Array | undefined;
    observe(() => {
      if (c.closed || c.recording.reason) return;
      if (!current) {
        current = {
          frames: [],
          unclaimed: [],
          duration: 0,
          owner: nativeId(c.session.activity?.currentSpeech?._agentTurnSpan),
          ranges: [],
          inFlight: 0,
          hold: Math.max(0, Date.now() - c.origin - 1000),
          processed: 0,
          hadProgress: false,
        };
        segments.push(current);
        c.outputHolds.set(current, current.hold);
      }
      segment = current;
      segment.inFlight++;
      pcm = copyFrame(c, frame);
    });
    try {
      const result = await Reflect.apply(captureFrame, this, [frame, ...args]);
      observe(() => {
        if (segment && pcm && !c.recording.reason) {
          segment.frames.push({
            pcm,
            rate: frame.sampleRate,
            channels: frame.channels,
            channel: 1,
            at: segment.duration,
          });
          segment.duration += c.timeline.pcmBytesToMs(
            pcm.byteLength,
            frame.sampleRate,
            frame.channels,
          );
        }
      });
      return result;
    } catch (error) {
      observe(() => omit(c, "output_capture_failed"));
      throw error;
    } finally {
      observe(() => {
        if (segment) {
          segment.inFlight--;
          settle(segment);
        }
        if (pcm && c.recording.reason) c.recording.release(pcm);
      });
    }
  };
  for (const method of ["flush", "clearBuffer"] as const) {
    const original = sink[method];
    if (typeof original !== "function") continue;
    sink[method] = function (...args: any[]) {
      current = undefined;
      return Reflect.apply(original, this, args);
    };
  }
}
