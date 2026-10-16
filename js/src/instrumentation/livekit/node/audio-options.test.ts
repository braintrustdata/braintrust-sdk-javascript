import { beforeEach, afterEach, expect, test, vi } from "vitest";
import * as extension from "../../../../../integrations/audio/src/index";
import { resolveAudioOptions } from "./audio-options";
beforeEach(() => {
  for (const key of [
    "BRAINTRUST_CAPTURE_ATTACHMENTS",
    "BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS",
    "BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS",
  ])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
test("disabled capture never loads the recording extension, even when installed and environment-enabled", () => {
  vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", "true");
  const load = vi.fn(() => extension);
  expect(resolveAudioOptions({ captureAudio: false }, load)).toEqual({
    user: false,
    agent: false,
  });
  expect(load).not.toHaveBeenCalled();
});
test.each(["true", "1", " TRUE "])(
  "participant options override the %s audio environment opt-in",
  (value) => {
    vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "false");
    vi.stubEnv("BRAINTRUST_CAPTURE_AGENT_AUDIO_ATTACHMENTS", value);
    vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "false");
    const load = vi.fn(() => extension);
    expect(resolveAudioOptions({}, load)).toEqual({
      user: false,
      agent: true,
      extension,
    });
    expect(
      resolveAudioOptions(
        { captureAudio: false, captureAgentAudio: true },
        load,
      ),
    ).toEqual({ user: false, agent: true, extension });
  },
);
test.each([undefined, "wav", "ogg"] as const)(
  "%s uses the recording extension and gracefully handles its absence",
  (audioFormat) => {
    const load = vi.fn(() => extension);
    expect(
      resolveAudioOptions({ captureAudio: true, audioFormat }, load),
    ).toEqual({ user: true, agent: true, extension });
    expect(load).toHaveBeenCalledTimes(1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      resolveAudioOptions({ captureAudio: true, audioFormat }, () => {
        throw new Error("missing");
      }),
    ).toEqual({ user: false, agent: false });
  },
);

test("generic attachment capture does not enable voice recording or load the extension", () => {
  vi.stubEnv("BRAINTRUST_CAPTURE_ATTACHMENTS", "true");
  const load = vi.fn(() => extension);
  expect(resolveAudioOptions({}, load)).toEqual({ user: false, agent: false });
  expect(load).not.toHaveBeenCalled();
  vi.stubEnv("BRAINTRUST_CAPTURE_USER_AUDIO_ATTACHMENTS", "true");
  expect(resolveAudioOptions({}, load)).toEqual({
    user: true,
    agent: false,
    extension,
  });
});
