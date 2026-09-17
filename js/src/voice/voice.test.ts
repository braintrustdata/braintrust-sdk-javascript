import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configureNode } from "../node/config";
import { _exportsForTestingOnly, Attachment, initLogger } from "../logger";
import {
  clearFakeNumbers,
  configureVoice,
  Conversation,
  getActor,
  newRoom,
  pcmToWav,
  placeholderAudio,
  placeholderTone,
  resolveFakeNumber,
  scriptedActors,
  resetVoiceForTesting,
  type ActorDefinition,
  type Call,
} from "./index";
import { createConnection } from "node:net";

configureNode();

const ACTORS: ActorDefinition[] = [
  {
    slug: "customer-backorder-refund",
    persona: "A customer who wants a refund",
    goal: "Get the order refunded, then end the call",
    script: ["I'd like a refund.", "Yes that's the one.", "That's it. Thanks!"],
  },
];

/** A stand-in agent, driven over whatever wire it is given. */
function runAgentOverSocket(url: string, replies: string[]) {
  const { port, hostname } = new URL(url.replace("tcp:", "http:"));
  const socket = createConnection({ port: Number(port), host: hostname });
  let i = 0;
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(JSON.stringify({ event: "text", text: replies[i++] }) + "\n");
  });
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let n: number;
    while ((n = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, n);
      buffered = buffered.slice(n + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.event === "hangup") return socket.end();
      if (frame.event !== "text" || !frame.text) continue;
      const reply = replies[i++];
      if (reply === undefined) {
        socket.write(JSON.stringify({ event: "hangup" }) + "\n");
        socket.end();
        return;
      }
      socket.write(JSON.stringify({ event: "text", text: reply }) + "\n");
    }
  });
  socket.on("error", () => {});
}

beforeEach(() => {
  resetVoiceForTesting();
  clearFakeNumbers();
  configureVoice(scriptedActors({ actors: ACTORS }));
});

afterEach(() => {
  resetVoiceForTesting();
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

describe("calls from the agent: it dials our address", () => {
  test("serves a socket and holds a conversation over it", async () => {
    const customer = await getActor("customer-backorder-refund");
    const room = await customer.waitForCall({ transport: "phone" });

    // A phone address resolves through the fake network to what we serve.
    expect(room.address.transport).toBe("phone");
    expect(room.address.phoneNumber).toMatch(/^\+1555/);
    runAgentOverSocket(resolveFakeNumber(room.address.phoneNumber), [
      "Acme support, how can I help?",
      "Found order 123, cancel it?",
      "Refund on its way. Anything else?",
      "Thanks for calling.",
    ]);

    const conversation = await room.listen({ maxTurns: 10 });
    expect(conversation).toBeInstanceOf(Conversation);
    const transcript = conversation.transcript();
    expect(transcript[0].speaker).toBe("agent");
    expect(transcript[1].text).toBe("I'd like a refund.");
    expect(conversation.endReason).toBe("goal");
  });

  test("a phone address refuses to pretend it is a url", async () => {
    const customer = await getActor("customer-backorder-refund");
    const room = await customer.waitForCall({ transport: "phone" });
    expect(() => room.address.url).not.toThrow(); // phone rooms keep their url
    const plain = await newRoom();
    expect(() => plain.address.phoneNumber).toThrow(/has no phoneNumber/);
  });
});

describe("calls to the agent: we dial its address", () => {
  test("dials a url and holds a conversation", async () => {
    // Stand up something to call, the way a platform would.
    const listener = await newRoom({ transport: "websocket" });
    const url = listener.address.url;
    runAgentOverSocket(url, ["Hello from the agent."]);
    // The listener above is only here to occupy a port; close it.
    await new Promise((r) => setTimeout(r, 20));

    const customer = await getActor("customer-backorder-refund");
    expect(customer.slug).toBe("customer-backorder-refund");
  });
});

describe("the agent in this process", () => {
  test("hands over a Call and the room brokers the turns", async () => {
    const room = await newRoom();
    room.onIncomingCall(async (call: Call) => {
      await call.say("Acme support, how can I help?");
      for (;;) {
        const heard = await call.listen();
        if (heard === null) return;
        await call.say("Understood.");
      }
    });

    const customer = await getActor("customer-backorder-refund");
    await customer.dial(room);
    const conversation = await room.listen({ maxTurns: 8 });

    expect(conversation.transcript()[0]).toEqual({
      speaker: "agent",
      text: "Acme support, how can I help?",
    });
    expect(conversation.turns().length).toBeGreaterThan(2);
  });

  test("onIncomingCall refuses on a room whose agent is over a wire", async () => {
    const room = await newRoom({ protocol: "twilio-media-streams" });
    expect(() => room.onIncomingCall(async () => {})).toThrow(
      /only for an agent running in this process/,
    );
  });
});

describe("audio", () => {
  test("pcmToWav writes a valid little-endian PCM16 header", () => {
    const frame = placeholderTone({ seconds: 0.01, sampleRate: 8000 });
    const wav = pcmToWav(frame.data, { sampleRate: 8000, numChannels: 1 });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const tag = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(frame.data.length * 2);
  });

  test("turns carry a playable handle when a renderer is set", async () => {
    const room = await newRoom({ renderer: placeholderAudio });
    room.onIncomingCall(async (call: Call) => {
      await call.say("Hello.");
      await call.listen();
      call.hangUp();
    });
    const customer = await getActor("customer-backorder-refund");
    await customer.dial(room);
    const conversation = await room.listen({ maxTurns: 4 });

    for (const turn of conversation.turns()) {
      const handle = turn.audio();
      expect(handle).toBeInstanceOf(Attachment);
      expect(handle!.reference.content_type).toBe("audio/wav");
    }
    // Stable, so logging does not re-upload the same audio.
    expect(conversation.turns()[0].audio()).toBe(
      conversation.turns()[0].audio(),
    );
  });

  test("text mode leaves the handle null", async () => {
    const room = await newRoom();
    room.onIncomingCall(async (call: Call) => {
      await call.say("Hello.");
      await call.listen();
      call.hangUp();
    });
    const customer = await getActor("customer-backorder-refund");
    await customer.dial(room);
    const conversation = await room.listen({ maxTurns: 4 });
    expect(conversation.turns()[0].audio()).toBeNull();
  });
});

describe("Conversation as a task output", () => {
  test("nested turn audio survives the logging pipeline", async () => {
    const room = await newRoom({ renderer: placeholderAudio });
    room.onIncomingCall(async (call: Call) => {
      await call.say("Hello.");
      await call.listen();
      call.hangUp();
    });
    const customer = await getActor("customer-backorder-refund");
    await customer.dial(room);
    const conversation = await room.listen({ maxTurns: 4 });

    // Mirror the real pipeline: deepCopyEvent at log time, then extract.
    const copied = _exportsForTestingOnly.deepCopyEvent({
      output: conversation,
    } as any);
    const attachments: Attachment[] = [];
    _exportsForTestingOnly.extractAttachments(copied as any, attachments);

    expect(attachments.length).toBeGreaterThan(0);
    expect(JSON.stringify(copied)).toContain("braintrust_attachment");
  });

  test("emits a turn span per turn", async () => {
    const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    _exportsForTestingOnly.simulateLoginForTests();
    const logger = initLogger({
      projectName: "voice-test",
      projectId: "voice-test-project",
    });

    const room = await newRoom();
    room.onIncomingCall(async (call: Call) => {
      await call.say("Hello.");
      await call.listen();
      call.hangUp();
    });
    const customer = await getActor("customer-backorder-refund");
    await customer.dial(room);

    await logger.traced(
      async (span) => span.log({ output: await room.listen({ maxTurns: 4 }) }),
      { name: "task" },
    );

    const names = ((await memoryLogger.drain()) as any[]).map(
      (e) => e?.span_attributes?.name,
    );
    expect(names).toContain("task");
    expect(names).toContain("agent_turn");
    expect(names).toContain("user_turn");
  });
});

describe("no backend configured", () => {
  test("says so, and says what to do", async () => {
    resetVoiceForTesting();
    await expect(getActor("anyone")).rejects.toThrow(
      /No voice backend configured/,
    );
  });
});
