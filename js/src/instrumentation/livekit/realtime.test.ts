/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { RealtimeObserver } from "./realtime";

function fixture(content = true, maxPauseMs = 0) {
  const turns: any[] = [];
  const root: any = {
    startSpan(args: any) {
      const span = {
        spanId: `turn-${turns.length}`,
        args,
        logs: [] as any[],
        ends: [] as any[],
        log(event: any) {
          this.logs.push(event);
        },
        end(event: any) {
          this.ends.push(event);
        },
      };
      turns.push(span);
      return span;
    },
  };
  const session = new EventEmitter();
  const observer = new RealtimeObserver(
    session,
    root,
    content,
    () => undefined,
    maxPauseMs,
  );
  return { turns, session, observer };
}

test("duplex events create caller turns before LiveKit dispatch and associate delayed transcripts", async () => {
  const { turns, session, observer } = fixture();
  let parent: any;
  session.on("input_speech_started", () => {
    parent = observer.takeSpeakingTurn();
  });
  session.emit("input_speech_started", {});
  expect(parent).toBe(turns[0]);
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "Order",
    isFinal: false,
  });
  session.emit("input_speech_stopped", {});
  await new Promise((resolve) => setTimeout(resolve, 2));
  session.emit("input_speech_started", {});
  session.emit("input_audio_transcription_completed", {
    itemId: "u2",
    transcript: "Thanks",
    isFinal: false,
  });
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "Order 1042",
    isFinal: true,
  });
  expect(turns).toHaveLength(2);
  expect(observer.message("u1")).toBe(turns[0]);
  expect(turns[0].logs).toContainEqual(
    expect.objectContaining({
      input: [{ role: "user", content: "Order 1042" }],
    }),
  );
  expect(
    turns[1].logs.some((e: any) => JSON.stringify(e).includes("Order")),
  ).toBe(false);
  observer.close();
  expect(session.listenerCount("input_audio_transcription_completed")).toBe(0);
  expect(turns[1].logs).toContainEqual(
    expect.objectContaining({
      metadata: expect.objectContaining({ "turn.incomplete": true }),
    }),
  );
});

test("a final transcript without speech events still creates a caller turn", () => {
  const { turns, session, observer } = fixture();
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "Where is my order?",
    isFinal: true,
    turnStartedAt: 1000,
  });
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "Where is my order?",
    isFinal: true,
    turnStartedAt: 1000,
  });
  expect(turns).toHaveLength(1);
  expect(turns[0].args.startTime).toBe(1);
  observer.close();
});

test("content opt-out and error monitoring preserve application behavior", () => {
  const { turns, session, observer } = fixture(false);
  const application = vi.fn();
  session.on("input_speech_started", application);
  session.emit("input_speech_started", {});
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "private",
    isFinal: true,
  });
  expect(application).toHaveBeenCalledOnce();
  expect(JSON.stringify(turns)).not.toContain("private");
  expect(() => session.emit("error", new Error("provider failure"))).toThrow(
    "provider failure",
  );
  observer.close();
  expect(session.listenerCount("input_speech_started")).toBe(1);
});

test("a response retains its caller's late transcript without picking up a later caller", async () => {
  const { session, observer } = fixture();
  const logs: any[] = [];
  session.emit("input_speech_started", {});
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "Where is",
    isFinal: false,
  });
  observer.captureInput({ log: (event: any) => logs.push(event) } as any);
  session.emit("input_speech_stopped", {});
  await new Promise((resolve) => setTimeout(resolve, 2));
  session.emit("input_speech_started", {});
  session.emit("input_audio_transcription_completed", {
    itemId: "u2",
    transcript: "Thanks",
    isFinal: false,
  });
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "Where is order 1042?",
    isFinal: true,
  });
  expect(logs.at(-1).input).toEqual([
    { role: "user", content: "Where is order 1042?" },
  ]);
  expect(JSON.stringify(logs)).not.toContain("Thanks");
  observer.close();
});

test("synchronous speech/transcript dispatch supplies identity even when producer timestamp precedes observation", () => {
  const { session, observer, turns } = fixture();
  const startedAt = Date.now() - 2;
  session.emit("input_speech_started", {});
  observer.takeSpeakingTurn();
  session.emit("input_audio_transcription_completed", {
    itemId: "caller",
    turnStartedAt: startedAt,
    transcript: "Where is my order?",
    isFinal: false,
  });
  expect(turns).toHaveLength(1);
  expect(observer.message("caller")).toBe(turns[0]);
  observer.close();
});

test("tool continuation retains the caller's original position in model context", () => {
  const { session, observer } = fixture();
  session.emit("input_speech_started", {});
  session.emit("input_audio_transcription_completed", {
    itemId: "u1",
    transcript: "Where is my order?",
    isFinal: true,
  });
  session.emit("input_speech_stopped", {});
  Object.assign(session, {
    chatCtx: {
      items: [
        {
          id: "u1",
          type: "message",
          role: "user",
          content: ["Where is my order?"],
        },
        {
          id: "a1",
          type: "message",
          role: "assistant",
          content: ["Checking now."],
        },
        { type: "function_call_output", callId: "lookup", output: "Friday" },
      ],
    },
  });
  const log = vi.fn();
  observer.captureInput({ log } as any);
  expect(log.mock.calls.at(-1)![0].input).toEqual([
    { role: "user", content: "Where is my order?" },
    { role: "assistant", content: "Checking now." },
    { role: "tool", content: "Friday", tool_call_id: "lookup" },
  ]);
  observer.close();
});

test("historical caller fragments stay grouped when a later caller speaks", async () => {
  const { session, observer } = fixture();
  // This fixture uses a zero pause window; synchronous fragments share its boundary.
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (const [id, text] of [
      ["u1", "Where is my order"],
      ["u2", " DMO1042?"],
    ]) {
      session.emit("input_speech_started", {});
      session.emit("input_audio_transcription_completed", {
        itemId: id,
        transcript: text,
        isFinal: true,
      });
      session.emit("input_speech_stopped", {});
    }
    clock.mockReturnValue(5000);
    session.emit("input_speech_started", {});
    session.emit("input_audio_transcription_completed", {
      itemId: "u3",
      transcript: "Thanks",
      isFinal: true,
    });
    Object.assign(session, {
      chatCtx: {
        items: [
          {
            id: "u1",
            type: "message",
            role: "user",
            content: ["Where is my order"],
          },
          { id: "u2", type: "message", role: "user", content: [" DMO1042?"] },
          {
            id: "a1",
            type: "message",
            role: "assistant",
            content: ["Friday."],
          },
          { id: "u3", type: "message", role: "user", content: ["Thanks"] },
        ],
      },
    });
    const log = vi.fn();
    observer.captureInput({ log } as any);
    expect(log.mock.calls.at(-1)![0].input).toEqual([
      { role: "user", content: "Where is my order DMO1042?" },
      { role: "assistant", content: "Friday." },
      { role: "user", content: "Thanks" },
    ]);
  } finally {
    clock.mockRestore();
    observer.close();
  }
});

test("reconnect ends an unfinished caller but preserves completed conversation grouping", () => {
  const { session, observer, turns } = fixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (const [id, text] of [
      ["u1", "Where is"],
      ["u2", " my order?"],
    ]) {
      session.emit("input_speech_started", {});
      session.emit("input_audio_transcription_completed", {
        itemId: id,
        transcript: text,
        isFinal: true,
      });
      session.emit("input_speech_stopped", {});
    }
    clock.mockReturnValue(5000);
    session.emit("input_speech_started", {});
    session.emit("input_audio_transcription_completed", {
      itemId: "partial",
      transcript: "Wait",
      isFinal: false,
    });
    session.emit("session_reconnected", {});
    expect(turns[1].logs).toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ "turn.incomplete": true }),
      }),
    );
    expect(observer.takeSpeakingTurn()).toBeUndefined();
    Object.assign(session, {
      chatCtx: {
        items: [
          { id: "u1", type: "message", role: "user", content: ["Where is"] },
          { id: "u2", type: "message", role: "user", content: [" my order?"] },
        ],
      },
    });
    const log = vi.fn();
    observer.captureInput({ log } as any);
    expect(log.mock.calls.at(-1)![0].input).toEqual([
      { role: "user", content: "Where is my order?" },
    ]);
    session.emit("input_speech_started", {});
    session.emit("input_audio_transcription_completed", {
      itemId: "next",
      transcript: "Please continue",
      isFinal: true,
    });
    expect(turns).toHaveLength(3);
    expect(observer.message("next")).toBe(turns[2]);
  } finally {
    observer.close();
    clock.mockRestore();
  }
});

test("grouped caller fragments do not move across intervening assistant messages", () => {
  const { session, observer, turns } = fixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (const [itemId, transcript] of [
      ["u1", "Where is my order?"],
      ["u2", "Thanks. Tell me more."],
    ]) {
      session.emit("input_speech_started", {});
      session.emit("input_audio_transcription_completed", {
        itemId,
        transcript,
        isFinal: true,
      });
      session.emit("input_speech_stopped", {});
    }
    expect(turns).toHaveLength(1);
    Object.assign(session, {
      chatCtx: {
        items: [
          {
            id: "u1",
            type: "message",
            role: "user",
            content: ["Where is my order?"],
          },
          {
            id: "a1",
            type: "message",
            role: "assistant",
            content: ["Checking now."],
          },
          {
            id: "u2",
            type: "message",
            role: "user",
            content: ["Thanks. Tell me more."],
          },
        ],
      },
    });
    const log = vi.fn();
    observer.captureInput({ log } as any);
    const expected = [
      { role: "user", content: "Where is my order?" },
      { role: "assistant", content: "Checking now." },
      { role: "user", content: "Thanks. Tell me more." },
    ];
    expect(log.mock.calls.at(-1)![0].input).toEqual(expected);
    // The latest transcript can arrive before LiveKit commits it to chatCtx.
    (session as any).chatCtx.items.pop();
    observer.captureInput({ log } as any);
    expect(log.mock.calls.at(-1)![0].input).toEqual(expected);
    (session as any).chatCtx.items.push({
      id: "u2",
      type: "message",
      role: "user",
      content: ["Thanks. Tell me more."],
    });
    session.emit("session_reconnected", {});
    observer.captureInput({ log } as any);
    expect(log.mock.calls.at(-1)![0].input).toEqual(expected);
  } finally {
    observer.close();
    clock.mockRestore();
  }
});

test("a response's own generated message is excluded from its input", () => {
  const { session, observer } = fixture();
  Object.assign(session, {
    chatCtx: {
      items: [
        {
          id: "user",
          type: "message",
          role: "user",
          content: ["Order status?"],
        },
        {
          id: "answer",
          type: "message",
          role: "assistant",
          content: ["Friday."],
        },
      ],
    },
  });
  const log = vi.fn();
  const excludeOutput = observer.captureInput({ log } as any);
  excludeOutput?.("answer");
  expect(log.mock.calls.at(-1)![0].input).toEqual([
    { role: "user", content: "Order status?" },
  ]);
  observer.close();
});

test("caller fragments end once at the last speech stop, not at the first fragment", () => {
  const { session, observer, turns } = fixture(true, 3000);
  const clock = vi.spyOn(Date, "now");
  try {
    for (const [start, end, id, transcript] of [
      [1000, 1500, "u1", "Where is my order"],
      [1800, 2200, "u2", " DMO1042?"],
    ] as const) {
      clock.mockReturnValue(start);
      session.emit("input_speech_started", {});
      session.emit("input_audio_transcription_completed", {
        itemId: id,
        transcript,
        isFinal: true,
      });
      clock.mockReturnValue(end);
      session.emit("input_speech_stopped", {});
    }
    clock.mockReturnValue(5000);
    observer.close();
    expect(turns).toHaveLength(1);
    expect(turns[0].ends).toEqual([{ endTime: 2.2 }]);
  } finally {
    clock.mockRestore();
  }
});

test("completed assistant playback separates caller turns inside the pause window", () => {
  const { session, observer, turns } = fixture(true, 3000);
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    session.emit("input_speech_started", {});
    session.emit("input_audio_transcription_completed", {
      itemId: "question",
      transcript: "Where is my order DMO1042?",
      isFinal: true,
    });
    clock.mockReturnValue(1500);
    session.emit("input_speech_stopped", {});
    observer.assistantSpeechEnded(2200);
    clock.mockReturnValue(2600);
    session.emit("input_speech_started", {});
    session.emit("input_audio_transcription_completed", {
      itemId: "followup",
      transcript: "Thanks. Tell me more.",
      isFinal: true,
    });
    clock.mockReturnValue(3100);
    session.emit("input_speech_stopped", {});
    observer.close();
    expect(turns).toHaveLength(2);
    expect(
      turns.map(
        (turn) => turn.logs.filter((log: any) => log.input).at(-1).input,
      ),
    ).toEqual([
      [{ role: "user", content: "Where is my order DMO1042?" }],
      [{ role: "user", content: "Thanks. Tell me more." }],
    ]);
    expect(turns.map((turn) => turn.ends)).toEqual([
      [{ endTime: 1.5 }],
      [{ endTime: 3.1 }],
    ]);
  } finally {
    observer.close();
    clock.mockRestore();
  }
});
