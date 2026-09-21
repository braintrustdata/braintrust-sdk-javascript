/**
 * The agent's end of a call.
 *
 * One implementation per way an agent is reachable:
 *
 *   ClientLeg     we dial the agent        -> "calls to the agent"
 *   ServerLeg     the agent dials us       -> "calls from the agent"
 *   InProcessLeg  the agent is right here  -> the appendix shortcut
 *   AcpLeg        the agent is a process   -> acp.ts, prompt turns over stdio
 *
 * The room drives all three identically, which is the property that keeps
 * adding a transport an adapter rather than a change to the core.
 *
 * LABELLED SUBSTITUTION: the wire here is newline-delimited JSON over a TCP
 * socket, not a WebSocket speaking a vendor's media-stream protocol. The core
 * SDK has no WebSocket server dependency, and what this demo needs to prove is
 * the client/server split and the framing, both of which are the same. A real
 * adapter swaps this file and nothing above it.
 */

import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { AudioFrame } from "./types";
import { decode, encode, frameToPayload, payloadToFrame } from "./wire";

export interface AgentLeg {
  /** Resolves when the far side is ready for audio, not merely connected. */
  ready(): Promise<void>;
  /**
   * Tell the far side the call is starting, and which way it is going.
   *
   * Separate from connecting on purpose. A bridged agent connects to us before
   * anyone has dialled, so at connect time the room does not yet know whether
   * this will be a call in or a call out.
   */
  begin(direction: "inbound" | "outbound"): void;
  /** Give the agent what the caller just said. */
  send(text: string, audio: AudioFrame | null): Promise<void>;
  /** Await the agent's next utterance. Null means it hung up. */
  receive(): Promise<Heard | null>;
  close(): void;
}

export interface Heard {
  text: string;
  audio: AudioFrame | null;
  /** Set where the agent asked to proceed and a policy answered for it. */
  permissions?: { request: string; decision: string }[];
}

/** A tiny single-slot channel. One writer, one reader. */
export class Slot<T> {
  private pending: ((v: T) => void) | null = null;
  private queued: T[] = [];

  put(value: T): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(value);
    } else {
      this.queued.push(value);
    }
  }

  take(): Promise<T> {
    // Length, not `!== undefined`: a Slot<void> queues `undefined` as a real
    // value, and testing for it would make the signal invisible forever.
    if (this.queued.length > 0)
      return Promise.resolve(this.queued.shift() as T);
    return new Promise<T>((resolve) => {
      this.pending = resolve;
    });
  }
}

abstract class SocketLeg implements AgentLeg {
  protected readonly inbox = new Slot<Heard | null>();
  protected socket: Socket | null = null;
  private readySignal = new Slot<void>();
  private readyOnce: Promise<void> | null = null;
  private buffers = new WeakMap<Socket, string>();
  /** True once the current socket has actually said something. */
  private spoken = false;
  /** Remembered until there is a socket to announce it to. */
  private pendingBegin: "inbound" | "outbound" | null = null;

  /**
   * A listening socket gets connected to by things that are not the agent:
   * health checks, port scanners, a retrying client. So a connection is only
   * provisionally the far end, and only becomes the peer once it speaks our
   * protocol. One that hangs up without speaking is forgotten rather than
   * treated as a hangup, and the next connection gets the chance.
   */
  private onGone(socket: Socket): void {
    if (socket !== this.socket) return;
    if (this.spoken) {
      this.inbox.put(null);
      return;
    }
    this.socket = null;
  }

  protected attach(socket: Socket): void {
    // Hold the newest quiet connection; a peer that has spoken keeps its place.
    if (this.spoken && this.socket && this.socket !== socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding("utf8");
    if (this.pendingBegin)
      this.write({ event: "start", direction: this.pendingBegin });
    socket.on("data", (chunk: string) => {
      this.buffers.set(socket, (this.buffers.get(socket) ?? "") + chunk);
      let newline: number;
      for (;;) {
        const buffered = this.buffers.get(socket) ?? "";
        newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        this.buffers.set(socket, buffered.slice(newline + 1));
        if (!line.trim()) continue;
        const frame = decode(line);
        if (!frame) continue;
        // Whoever speaks our protocol first is the far end of this call.
        if (!this.spoken) {
          this.spoken = true;
          this.socket = socket;
        } else if (socket !== this.socket) {
          continue;
        }
        if (frame.event === "utterance") {
          this.inbox.put({
            text: frame.text,
            audio:
              frame.payload && frame.sampleRate
                ? payloadToFrame(frame.payload, frame.sampleRate)
                : null,
          });
        } else if (frame.event === "hangup") {
          this.inbox.put(null);
        }
      }
    });
    socket.on("close", () => this.onGone(socket));
    socket.on("error", () => this.onGone(socket));
    this.readySignal.put();
  }

  protected write(frame: Parameters<typeof encode>[0]): void {
    try {
      this.socket?.write(encode(frame) + "\n");
    } catch {
      // Socket already gone.
    }
  }

  ready(): Promise<void> {
    if (!this.readyOnce) this.readyOnce = this.readySignal.take();
    return this.readyOnce;
  }

  begin(direction: "inbound" | "outbound"): void {
    this.pendingBegin = direction;
    this.write({ event: "start", direction });
  }

  async send(text: string, audio: AudioFrame | null): Promise<void> {
    this.write({
      event: "utterance",
      text,
      ...(audio
        ? { payload: frameToPayload(audio), sampleRate: audio.sampleRate }
        : {}),
    });
  }

  receive() {
    return this.inbox.take();
  }

  close(): void {
    this.write({ event: "hangup" });
    try {
      this.socket?.end();
    } catch {
      // Already closed.
    }
  }
}

/** We dial the agent: the room is the client. */
export class ClientLeg extends SocketLeg {
  constructor(private readonly url: string) {
    super();
  }

  async connect(): Promise<void> {
    const { port, hostname } = new URL(
      this.url.replace(/^(tcp|ws|sip):/, "http:"),
    );
    const socket = createConnection({
      port: Number(port),
      host: hostname,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.unref();
    this.attach(socket);
  }
}

/** The agent dials us: the room listens, and has an address. */
export class ServerLeg extends SocketLeg {
  private server: Server | null = null;
  private _url = "";

  async serve(): Promise<string> {
    const server = createServer();
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this._url = `tcp://127.0.0.1:${port}`;
    // A finished eval should exit, not linger on an idle listener.
    server.unref();
    server.on("connection", (socket) => this.attach(socket));
    return this._url;
  }

  get url(): string {
    return this._url;
  }

  override close(): void {
    super.close();
    this.server?.close();
  }
}

/**
 * The agent is a function in this process.
 *
 * The appendix shortcut: no wire exists, so the room hands the agent a `Call`
 * and this leg is the other side of it.
 */
export class InProcessLeg implements AgentLeg {
  readonly toAgent = new Slot<Heard | null>();
  readonly toRoom = new Slot<Heard | null>();
  private over = false;

  async ready(): Promise<void> {}

  /** No wire, so nothing to announce. */
  begin(): void {}

  async send(text: string, audio: AudioFrame | null): Promise<void> {
    if (!this.over) this.toAgent.put({ text, audio });
  }

  receive() {
    return this.toRoom.take();
  }

  close(): void {
    if (this.over) return;
    this.over = true;
    this.toAgent.put(null);
  }
}
