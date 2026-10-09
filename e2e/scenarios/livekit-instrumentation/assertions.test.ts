import { expect, test } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { assertAudioTrace } from "./assertions";

function event(
  id: string,
  name: string,
  parentIds: string[],
  metadata: Record<string, unknown> = {},
): CapturedLogEvent {
  const metrics = { start: 1, end: 2 };
  return {
    apiVersion: 3,
    isMerge: false,
    metadata,
    metrics,
    row: { span_parents: parentIds, metadata, metrics },
    span: { id, name, parentIds, started: true, ended: true },
  };
}
const root = event("root", "livekit.agent_session", []);
const turn = event("turn", "user_turn", ["root"]);

test.each([undefined, "missing", "root"])(
  "rejects missing or invalid speaking turn reference: %s",
  (turnId) => {
    const speech = event(
      "speech",
      "livekit.user_speaking",
      ["root"],
      turnId ? { "turn.id": turnId } : {},
    );
    expect(() => assertAudioTrace([root, turn, speech])).toThrow();
  },
);

test("validates parentage and permits only explicitly expected session-owned speech", () => {
  const speech = event("speech", "livekit.user_speaking", ["turn"], {
    "turn.id": "turn",
  });
  expect(() => assertAudioTrace([root, turn, speech])).not.toThrow();
  speech.row.span_parents = speech.span.parentIds = ["root"];
  expect(() => assertAudioTrace([root, turn, speech])).toThrow();
  speech.row.metadata = speech.metadata = {};
  expect(() =>
    assertAudioTrace([root, turn, speech], {
      unassociatedSpeaking: ["speech"],
    }),
  ).not.toThrow();
  expect(() =>
    assertAudioTrace([root, turn], { unassociatedSpeaking: ["speech"] }),
  ).toThrow();
});
