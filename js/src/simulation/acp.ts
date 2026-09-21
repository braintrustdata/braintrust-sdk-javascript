/**
 * The agent is a process, and the conversation is prompt turns.
 *
 * ACP is JSON-RPC over the agent's stdio: we spawn it, `initialize`, open a
 * session, and every turn is one `session/prompt` whose streamed chunks we
 * assemble back into a single utterance. Three things the protocol leaves to
 * the client, and this leg does them so nothing above it has to:
 *
 *   1. Open every turn. ACP has no ring and no unprompted agent speech, so an
 *      agent that greets first is an agent we ask to greet.
 *   2. Answer `session/request_permission` from policy, because a simulation
 *      runs unattended. What policy decided is recorded, because nothing on
 *      the wire says a person did not answer.
 *   3. Decide when a turn is over. `stopReason` is the only signal.
 *
 * Above this file nothing changes: the same `connect()`, the same
 * `simulate()`, the same thread out the other end, whether the agent is on a
 * phone line or on the end of a pipe.
 *
 * ACP is a text protocol in practice. Its content blocks do include audio,
 * behind the `audio` prompt capability, so a speaking simulated user reaches
 * an agent that advertises it as speech rather than as a transcript of
 * itself. Nothing in the wild does that today, and an agent that does not
 * advertise it is sent text only.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Slot, type AgentLeg, type Heard } from "./legs";
import { wavToFrame } from "./speech";
import { pcmToWav } from "./wav";
import { AcpTarget, AudioFrame, PermissionRecord } from "./types";

/** What the client sends when the agent is the one expected to speak first. */
export const DEFAULT_OPENING =
  "(a customer has just opened a chat with you) Greet them and ask how you " +
  "can help.";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

/** One turn, while its chunks are still arriving. */
interface Turn {
  text: string;
  audio: AudioFrame[];
  permissions: PermissionRecord[];
}

export class AcpLeg implements AgentLeg {
  private child: ChildProcess | null = null;
  private readonly inbox = new Slot<Heard | null>();
  private readonly pending = new Map<number, (result: any) => void>();
  private nextId = 0;
  private sessionId = "";
  private acceptsAudio = false;
  private turn: Turn | null = null;
  /** Turns asked for, and turns handed on. Equal means nobody is speaking. */
  private issued = 0;
  private taken = 0;
  private closed = false;
  private startup: Promise<void> | null = null;

  constructor(private readonly target: AcpTarget) {}

  /** Spawn the agent and open a session. Idempotent. */
  start(): Promise<void> {
    if (!this.startup) this.startup = this.open();
    return this.startup;
  }

  ready(): Promise<void> {
    return this.start();
  }

  /**
   * Nothing. A session is not a line, so there is no moment to announce: the
   * agent learns the conversation has started when it is first prompted.
   */
  begin(): void {}

  async send(text: string, audio: AudioFrame | null): Promise<void> {
    const prompt: unknown[] = [{ type: "text", text }];
    // Only when the agent said it takes audio. Sending a block it did not
    // advertise is how a prompt turn fails with the reason buried in stderr.
    if (audio && this.acceptsAudio) {
      const wav = pcmToWav(audio.data, {
        sampleRate: audio.sampleRate,
        numChannels: audio.numChannels,
      });
      prompt.push({
        type: "audio",
        data: Buffer.from(wav).toString("base64"),
        mimeType: "audio/wav",
      });
    }
    this.prompt(prompt);
  }

  receive(): Promise<Heard | null> {
    // Nobody is mid-turn, so the agent is waiting to be asked. Counting
    // rather than testing a flag: a turn that finished before anyone read it
    // has already cleared the flag, and re-prompting there would double up.
    if (this.issued === this.taken) {
      this.prompt([
        { type: "text", text: this.target.opening ?? DEFAULT_OPENING },
      ]);
    }
    this.taken++;
    return this.inbox.take();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Advisory, per the spec: the agent is asked to stop, not made to.
    if (this.sessionId) {
      this.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      });
    }
    const child = this.child;
    try {
      child?.stdin?.end();
    } catch {
      // Already gone.
    }
    if (!child) return;
    // A moment to exit on its own. An agent with work in flight, spans
    // included, has it truncated if it is killed here.
    const timer = setTimeout(() => child.kill(), 2000);
    if (typeof timer.unref === "function") timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }

  // ------------------------------------------------------------- the wire

  private async open(): Promise<void> {
    const [command, ...args] = this.target.command.split(" ").filter(Boolean);
    // stderr is inherited on purpose: when a customer's agent dies on
    // startup, its own error message is the only thing that explains why the
    // simulation then sat waiting for a turn that never came.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", this.reader());
    child.once("error", () => this.inbox.put(null));
    child.once("exit", () => {
      if (!this.closed) this.inbox.put(null);
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "braintrust-simulation", version: "1" },
    });
    this.acceptsAudio = Boolean(
      init?.agentCapabilities?.promptCapabilities?.audio,
    );
    const session = await this.request("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
    this.sessionId = session?.sessionId ?? "";
  }

  /** Newline-delimited JSON. That is the whole framing. */
  private reader(): (chunk: string) => void {
    let buffered = "";
    return (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.dispatch(JSON.parse(line) as Rpc);
        } catch {
          // Anything else on the pipe: a banner, a stray log line. A real
          // client tolerates it rather than treating it as a protocol error.
        }
      }
    };
  }

  private dispatch(message: Rpc): void {
    if (message.method === "session/update") {
      return this.update(message.params?.update ?? {});
    }
    if (message.method === "session/request_permission") {
      return this.decide(message);
    }
    // Any other request: answer it so the agent is not left blocked.
    if (message.method && message.id !== undefined) {
      return this.write({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    if (message.id !== undefined && !message.method) {
      const resolve = this.pending.get(message.id as number);
      if (resolve) {
        this.pending.delete(message.id as number);
        resolve(message.result);
      }
    }
  }

  private update(update: any): void {
    if (update.sessionUpdate !== "agent_message_chunk" || !this.turn) return;
    const content = update.content ?? {};
    if (content.type === "text") {
      this.turn.text += content.text ?? "";
    } else if (content.type === "audio" && typeof content.data === "string") {
      try {
        this.turn.audio.push(wavToFrame(Buffer.from(content.data, "base64")));
      } catch {
        // Not audio we can read. The text of the turn still stands.
      }
    }
  }

  /** No operator is present, so policy answers, and the answer is recorded. */
  private decide(message: Rpc): void {
    const allow = this.target.permissions === "allow";
    const wanted = allow
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
    const options: any[] = message.params?.options ?? [];
    const optionId =
      options.find((o) => wanted.includes(o?.kind))?.optionId ??
      (allow ? "allow" : "reject");
    this.turn?.permissions.push({
      request: message.params?.toolCall?.title ?? "unnamed request",
      decision: `${allow ? "allow" : "deny"} (by policy)`,
    });
    this.write({
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "selected", optionId } },
    });
  }

  private prompt(content: unknown[]): void {
    this.issued++;
    this.turn = { text: "", audio: [], permissions: [] };
    void this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: content,
    })
      .then(() => this.settle())
      .catch(() => this.settle());
  }

  /** The turn is over, because `session/prompt` returned. Hand it on. */
  private settle(): void {
    const turn = this.turn;
    this.turn = null;
    if (!turn) return;
    const audio = concat(turn.audio);
    // A turn with nothing in it is the chat equivalent of hanging up: there
    // is nothing to reply to and nothing to score.
    if (!turn.text.trim() && !audio) return this.inbox.put(null);
    this.inbox.put({
      text: turn.text,
      audio,
      ...(turn.permissions.length ? { permissions: turn.permissions } : {}),
    });
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const settled = new Promise<any>((resolve) =>
      this.pending.set(id, resolve),
    );
    this.write({ jsonrpc: "2.0", id, method, params });
    return settled;
  }

  private write(message: Rpc): void {
    try {
      this.child?.stdin?.write(JSON.stringify(message) + "\n");
    } catch {
      // The agent is gone. `exit` has already ended the conversation.
    }
  }
}

/** One utterance out of the chunks it streamed in, when they agree on a rate. */
function concat(frames: AudioFrame[]): AudioFrame | null {
  if (frames.length === 0) return null;
  const [first] = frames;
  const usable = frames.filter(
    (f) =>
      f.sampleRate === first.sampleRate && f.numChannels === first.numChannels,
  );
  if (usable.length === 1) return usable[0];
  const total = usable.reduce((n, f) => n + f.data.length, 0);
  const data = new Int16Array(total);
  let at = 0;
  for (const frame of usable) {
    data.set(frame.data, at);
    at += frame.data.length;
  }
  return { data, sampleRate: first.sampleRate, numChannels: first.numChannels };
}
