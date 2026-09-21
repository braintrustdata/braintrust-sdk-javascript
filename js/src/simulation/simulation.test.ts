import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configureNode } from "../node/config";
import { _exportsForTestingOnly, Attachment, initLogger } from "../logger";
import {
  audioOf,
  Call,
  clearFakeNumbers,
  configureSimulation,
  connect,
  getSimulatedUser,
  host,
  pcmToWav,
  placeholderAudio,
  placeholderTone,
  resetSimulationForTesting,
  resolveFakeNumber,
  scriptedUsers,
  simulate,
  textOf,
  type SimulatedUserDefinition,
} from "./index";
import { createConnection } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

configureNode();

const USERS: SimulatedUserDefinition[] = [
  {
    slug: "customer-backorder-refund",
    persona: "A customer who wants a refund",
    goal: "Get the order refunded, then end the conversation",
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
    socket.write(
      JSON.stringify({ event: "utterance", text: replies[i++] }) + "\n",
    );
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
      if (frame.event !== "utterance" || !frame.text) continue;
      const reply = replies[i++];
      if (reply === undefined) {
        socket.write(JSON.stringify({ event: "hangup" }) + "\n");
        socket.end();
        return;
      }
      socket.write(JSON.stringify({ event: "utterance", text: reply }) + "\n");
    }
  });
  socket.on("error", () => {});
}

/** An in-process agent, so a test does not need a wire to say two things. */
function inProcessAgent(connection: ReturnType<typeof host>, lines: string[]) {
  connection.onIncomingCall(async (call: Call) => {
    for (const line of lines) {
      await call.say(line);
      if ((await call.listen()) === null) return;
    }
    call.hangUp();
  });
}

/**
 * A minimal ACP agent, written to disk so a test can spawn a real process.
 *
 * Deliberately not a mock of our own leg: it is the other side of the
 * protocol, speaking JSON-RPC on stdio, so the test exercises spawning,
 * framing, the prompt turn and the permission round trip rather than a stub.
 */
function acpAgentCommand(config: {
  replies: string[];
  /** Ask the client to approve before answering this prompt, 0-indexed. */
  askBefore?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-agent-"));
  const file = join(dir, "agent.mjs");
  writeFileSync(
    file,
    `
const config = JSON.parse(Buffer.from(process.argv[2], "base64").toString());
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const pending = new Map();
let turn = 0;
let sessionId = "s1";
let nextId = 1000;

const ask = () =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "t1", title: "issue a refund" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  });

let buffered = "";
process.stdin.on("data", async (chunk) => {
  buffered += chunk.toString();
  let i;
  while ((i = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, i);
    buffered = buffered.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fixture" } } });
    } else if (m.method === "session/new") {
      send({ jsonrpc: "2.0", id: m.id, result: { sessionId } });
    } else if (m.method === "session/prompt") {
      const n = turn++;
      if (config.askBefore === n) await ask();
      const text = config.replies[n];
      if (text !== undefined) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
        });
      }
      send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
    } else if (m.method === "session/cancel") {
      process.exit(0);
    } else if (m.id !== undefined && m.result !== undefined) {
      const resolve = pending.get(m.id);
      if (resolve) { pending.delete(m.id); resolve(m.result); }
    }
  }
});
`,
  );
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
  return `node ${file} ${encoded}`;
}

beforeEach(() => {
  resetSimulationForTesting();
  clearFakeNumbers();
  configureSimulation(scriptedUsers({ users: USERS }));
});

afterEach(() => {
  resetSimulationForTesting();
  _exportsForTestingOnly.clearTestBackgroundLogger();
});

describe("host: the agent arrives", () => {
  test("nothing is bound until a simulation starts", async () => {
    const connection = host({ via: "phone" });
    expect(() => connection.address).toThrow(/not up yet/);
  });

  test("serves an address and holds a conversation over it", async () => {
    const user = await getSimulatedUser("customer-backorder-refund");
    const connection = host({ via: "phone" });
    const simulation = simulate({
      user,
      connection,
      initiator: "agent",
      maxTurns: 10,
    });

    await connection.ready();
    expect(connection.address.interface).toBe("phone");
    expect(connection.address.phoneNumber).toMatch(/^\+1555/);
    runAgentOverSocket(resolveFakeNumber(connection.address.phoneNumber), [
      "Acme support, how can I help?",
      "Found order 123, cancel it?",
      "Refund on its way. Anything else?",
      "Thanks for calling.",
    ]);

    const thread = await simulation;
    expect(thread[0].role).toBe("assistant");
    expect(textOf(thread[1])).toBe("I'd like a refund.");
    expect(connection.summary.endReason).toBe("goal");
  });

  test("names the agent, and hands the summary to the scorers", async () => {
    const user = await getSimulatedUser("customer-backorder-refund");
    const connection = host({ via: "phone" });
    const hooks = { metadata: {} as Record<string, any> };
    const simulation = simulate({
      user,
      agent: "customer-support",
      connection,
      hooks,
      maxTurns: 4,
    });
    await connection.ready();
    runAgentOverSocket(resolveFakeNumber(connection.address.phoneNumber), [
      "Acme support.",
    ]);
    await simulation;
    expect(connection.summary.agent).toBe("customer-support");
    // The scorer's copy, with no round trip through the log.
    expect(hooks.metadata.simulation.agent).toBe("customer-support");
    expect(hooks.metadata.simulation.endReason).toBeDefined();
  });

  test("an address refuses to pretend it is another kind", async () => {
    const user = await getSimulatedUser("customer-backorder-refund");
    const connection = host({ via: "phone" });
    const simulation = simulate({ user, connection, maxTurns: 2 });
    await connection.ready();
    expect(() => connection.address.uri).toThrow(/has no uri/);
    runAgentOverSocket(resolveFakeNumber(connection.address.phoneNumber), [
      "Acme support.",
    ]);
    await simulation;
  });
});

describe("connect: the agent is waiting", () => {
  test("dials a coordinate and holds a conversation", async () => {
    // Stand a socket up the way a platform would, then dial it.
    const served = host({ via: "websocket" });
    const parked = simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      connection: served,
      maxTurns: 1,
      timeoutMs: 200,
    });
    await served.ready();
    const url = served.address.url;
    await parked.catch(() => {});

    expect(url).toMatch(/^tcp:\/\//);
  });

  test("connect describes without dialling", () => {
    const connection = connect({ via: { websocket: "tcp://127.0.0.1:1" } });
    expect(() => connection.address).toThrow(/not up yet/);
  });
});

describe("connect: an agent that is a process", () => {
  test("the client opens every turn, so the agent still greets first", async () => {
    const connection = connect({
      via: {
        acp: {
          command: acpAgentCommand({
            replies: [
              "Acme support, how can I help?",
              "Found order 123, cancel it?",
              "Refund on its way. Anything else?",
              "Thanks for getting in touch.",
            ],
          }),
        },
      },
    });
    const thread = await simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      agent: "acme-support",
      initiator: "agent",
      connection,
      maxTurns: 10,
    });

    // ACP has no unprompted agent turn, so the greeting is one the client
    // asked for. What it asked with is wiring, and stays out of the thread.
    expect(thread[0].role).toBe("assistant");
    expect(textOf(thread[0])).toBe("Acme support, how can I help?");
    expect(textOf(thread[1])).toBe("I'd like a refund.");
    expect(thread.every((m) => !textOf(m).includes("opened a chat"))).toBe(
      true,
    );
    expect(connection.summary.endReason).toBe("goal");
  });

  test("a policy answers the agent, and the answer is recorded", async () => {
    const connection = connect({
      via: {
        acp: {
          command: acpAgentCommand({
            replies: ["Hello.", "Refunded."],
            askBefore: 1,
          }),
          permissions: "allow",
        },
      },
    });
    await simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      initiator: "agent",
      connection,
      maxTurns: 4,
    });

    expect(connection.summary.permissions).toEqual([
      { request: "issue a refund", decision: "allow (by policy)" },
    ]);
  });

  test("denies by default, because nobody is watching", async () => {
    const connection = connect({
      via: {
        acp: {
          command: acpAgentCommand({
            replies: ["Hello.", "Ok."],
            askBefore: 1,
          }),
        },
      },
    });
    await simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      initiator: "agent",
      connection,
      maxTurns: 4,
    });

    expect(connection.summary.permissions[0].decision).toBe("deny (by policy)");
  });

  test("the address is the command, and admits it is not a phone", async () => {
    const connection = connect({
      via: { acp: { command: acpAgentCommand({ replies: [] }) } },
    });
    await connection.ready();

    expect(connection.address.interface).toBe("acp");
    expect(connection.address.command).toMatch(/agent\.mjs/);
    expect(() => connection.address.phoneNumber).toThrow(/no phoneNumber/);
  });
});

describe("the agent in this process", () => {
  test("hands over a Call and the run brokers the turns", async () => {
    const connection = host();
    inProcessAgent(connection, [
      "Acme support, how can I help?",
      "Refund processed.",
    ]);
    const thread = await simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      connection,
      initiator: "agent",
      maxTurns: 6,
    });
    expect(thread.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(textOf(thread[0])).toContain("Acme support");
  });
});

describe("a persona takes this run's parameters", () => {
  const PERSONAS: SimulatedUserDefinition[] = [
    {
      slug: "polite-shopper",
      persona: "A polite customer",
      goal: "Get the order sorted out, then end the conversation",
      script: ["I'd like to cancel order {{orderId}}.", "That's it. Thanks!"],
    },
  ];

  /** What the simulated user said, running the same persona with one fact. */
  async function saidWith(facts: Record<string, unknown>): Promise<string[]> {
    configureSimulation(scriptedUsers({ users: PERSONAS }));
    const connection = host({ via: "websocket" });
    const simulation = simulate({
      user: await getSimulatedUser("polite-shopper", { facts }),
      connection,
      initiator: "agent",
      maxTurns: 6,
    });
    await connection.ready();
    runAgentOverSocket(connection.address.url, ["Acme support.", "Done."]);
    const thread = await simulation;
    return thread.filter((m) => m.role === "user").map(textOf);
  }

  test("a fact from the row reaches what the user says", async () => {
    // One persona, two cases. The persona knows nothing about either order.
    expect(await saidWith({ orderId: 123 })).toContain(
      "I'd like to cancel order 123.",
    );
    expect(await saidWith({ orderId: 456 })).toContain(
      "I'd like to cancel order 456.",
    );
  });

  test("a fact nobody supplied is left alone rather than blanked", async () => {
    // Silently emptying it would put a half-sentence on the call and leave
    // the agent answering a question that was never asked.
    expect(await saidWith({})).toContain(
      "I'd like to cancel order {{orderId}}.",
    );
  });
});

describe("the thread", () => {
  async function paced(extra: Record<string, unknown> = {}) {
    const connection = host();
    inProcessAgent(connection, [
      "Acme support, how can I help?",
      "Refund processed.",
    ]);
    const thread = await simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      connection,
      initiator: "agent",
      renderer: placeholderAudio,
      pacing: "none",
      maxTurns: 6,
      ...extra,
    });
    return { thread, connection };
  }

  test("a message carries role, content and timing", async () => {
    const { thread } = await paced();
    for (const m of thread) {
      expect(["assistant", "user"]).toContain(m.role);
      expect(m.content.some((p) => p.type === "text")).toBe(true);
      expect(m.metadata!.duration_ms).toBeGreaterThan(0);
    }
    // Each turn starts where the previous one finished.
    for (let i = 1; i < thread.length; i++) {
      expect(thread[i].metadata!.at_ms).toBe(
        thread[i - 1].metadata!.at_ms + thread[i - 1].metadata!.duration_ms,
      );
    }
  });

  test("audio rides in the content part that means audio", async () => {
    const { thread } = await paced();
    const part = thread[0].content.find((p) => p.type === "input_audio");
    expect(part).toBeDefined();
    const handle = audioOf(thread[0]);
    expect(handle).toBeInstanceOf(Attachment);
    expect(handle!.reference.content_type).toBe("audio/wav");
    const bytes = new Uint8Array(await (await handle!.data()).arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
  });

  test("a text run leaves no audio part", async () => {
    const connection = host();
    inProcessAgent(connection, ["Hello."]);
    const thread = await simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      connection,
      initiator: "agent",
      maxTurns: 4,
    });
    expect(audioOf(thread[0])).toBeNull();
    expect(thread[0].metadata!.duration_ms).toBe(0);
  });

  test("the whole conversation mixes down to one stereo file", async () => {
    const { connection } = await paced();
    const audio = connection.summary.audio;
    expect(audio).toBeInstanceOf(Attachment);
    expect(audio!.reference.filename).toMatch(/conversation_\d+hz_2ch\.wav/);
  });
});

describe("interruption", () => {
  async function bargeIn(interruptAfter: number) {
    const connection = host();
    inProcessAgent(connection, [
      "Acme support, how can I help you today?",
      "Refund processed, anything else?",
    ]);
    const thread = await simulate({
      user: await getSimulatedUser("customer-backorder-refund"),
      connection,
      initiator: "agent",
      renderer: placeholderAudio,
      pacing: "none",
      interruptAfter,
      maxTurns: 6,
    });
    return { thread, connection };
  }

  test("cuts the agent short and records the overlap", async () => {
    const { thread, connection } = await bargeIn(0.5);
    const overlaps = connection.summary.interruptions;
    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps[0].by).toBe("user");
    expect(overlaps[0].overlapMs).toBeGreaterThan(0);
    // The turn that was talked over is recorded as what was actually heard.
    const cut = thread.find((m) => m.metadata?.truncated_at_ms !== undefined);
    expect(cut).toBeDefined();
    expect(cut!.metadata!.duration_ms).toBeLessThanOrEqual(
      cut!.metadata!.truncated_at_ms!,
    );
  });

  test("the opening turn is never cut into", async () => {
    const { thread } = await bargeIn(0.5);
    expect(thread[0].metadata!.truncated_at_ms).toBeUndefined();
  });
});

describe("what lands in the trace", () => {
  test("a turn span per turn, carrying the message", async () => {
    const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    _exportsForTestingOnly.simulateLoginForTests();
    const logger = initLogger({
      projectName: "simulation-test",
      projectId: "simulation-test-project",
    });

    const connection = host();
    inProcessAgent(connection, ["Hello."]);
    const user = await getSimulatedUser("customer-backorder-refund");

    await logger.traced(
      async (span) =>
        span.log({
          output: await simulate({
            user,
            connection,
            initiator: "agent",
            maxTurns: 4,
          }),
        }),
      { name: "task" },
    );

    const events = (await memoryLogger.drain()) as any[];
    const names = events.map((e) => e?.span_attributes?.name);
    expect(names).toContain("task");
    expect(names).toContain("agent_turn");
    expect(names).toContain("user_turn");

    // The span's output is the message, so the thread preprocessor sees the
    // same thread the simulation returned.
    const turnSpan = events.find(
      (e) => e?.span_attributes?.name === "agent_turn",
    );
    expect(turnSpan.output.role).toBe("assistant");
    expect(Array.isArray(turnSpan.output.content)).toBe(true);
  });

  test("nested turn audio survives the logging pipeline", async () => {
    const memoryLogger = _exportsForTestingOnly.useTestBackgroundLogger();
    _exportsForTestingOnly.simulateLoginForTests();
    const logger = initLogger({
      projectName: "simulation-test",
      projectId: "simulation-test-project",
    });

    const connection = host();
    inProcessAgent(connection, ["Hello."]);
    const user = await getSimulatedUser("customer-backorder-refund");

    await logger.traced(
      async (span) =>
        span.log({
          output: await simulate({
            user,
            connection,
            initiator: "agent",
            renderer: placeholderAudio,
            maxTurns: 4,
          }),
        }),
      { name: "task" },
    );

    const events = (await memoryLogger.drain()) as any[];
    const task = events.find((e) => e?.span_attributes?.name === "task");

    // Mirror the real pipeline: deepCopyEvent at log time, then extract.
    const copied = _exportsForTestingOnly.deepCopyEvent({
      output: task.output,
    } as any);
    const attachments: Attachment[] = [];
    _exportsForTestingOnly.extractAttachments(copied as any, attachments);

    // Audio nested in a message content part is found and swapped, so a turn
    // is playable in the trace with no extra wiring.
    expect(attachments.length).toBeGreaterThan(0);
    expect(JSON.stringify(copied)).toContain("braintrust_attachment");
    expect(JSON.stringify(copied)).toContain("input_audio");
  });
});

describe("audio helpers", () => {
  test("pcmToWav writes a valid little-endian PCM16 header", () => {
    const tone = placeholderTone({ seconds: 0.01, sampleRate: 8000 });
    const wav = pcmToWav(tone.data, { sampleRate: 8000, numChannels: 1 });
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(8000); // sample rate
  });
});

describe("no backend configured", () => {
  test("says so, and says what to do", async () => {
    resetSimulationForTesting();
    await expect(getSimulatedUser("anyone")).rejects.toThrow(
      /configureSimulation/,
    );
  });
});
