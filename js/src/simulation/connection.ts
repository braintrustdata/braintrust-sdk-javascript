/**
 * The medium, described before it exists.
 *
 * `connect()` and `host()` both return a plain value. Nothing is dialled,
 * spawned, bound or opened until `simulate()` runs, so a real number is not
 * ringing while the task is still setting up, and an address cannot be handed
 * out before somebody is on the line to answer it.
 */

import { AcpLeg } from "./acp";
import { makeAddress } from "./address";
import { Call } from "./call";
import { AgentLeg, ClientLeg, InProcessLeg, ServerLeg } from "./legs";
import { registerFakeNumber, resolveFakeNumber } from "./phone";
import {
  Address,
  ConnectOptions,
  HostInterface,
  HostOptions,
  Summary,
  Target,
} from "./types";

type Spec =
  | { kind: "connect"; via: Target; timeoutMs?: number }
  | { kind: "host"; via: HostInterface }
  | { kind: "in-process" };

/** Where the coordinate in a target lives, whichever interface it names. */
function coordinate(via: Exclude<Target, { acp: unknown }>): string {
  if ("websocket" in via) return via.websocket;
  if ("sip" in via) return via.sip;
  if ("livekit" in via) return via.livekit.url;
  // A number we can only reach because the fake network knows it.
  return resolveFakeNumber(via.phone);
}

export class Connection {
  private leg: AgentLeg | null = null;
  private _address: Address | null = null;
  private _summary: Summary | null = null;
  private binding: Promise<AgentLeg> | null = null;

  /** @internal */
  constructor(private readonly spec: Spec) {}

  /**
   * Where the agent reaches this connection.
   *
   * Real only once a simulation has started, because until then nothing is
   * bound and there is no coordinate to give away.
   */
  get address(): Address {
    if (!this._address) {
      throw new Error(
        "This connection is not up yet. A simulation brings it up, so start " +
          "one and await connection.ready() before handing an address out.",
      );
    }
    return this._address;
  }

  /** How the conversation went. Available once it is over. */
  get summary(): Summary {
    if (!this._summary) {
      throw new Error(
        "This connection has not carried a conversation yet, so there is " +
          "nothing to summarise.",
      );
    }
    return this._summary;
  }

  /**
   * Hand a `Call` to an agent running in this process.
   *
   * The appendix shortcut. Throws on a connection whose agent is reachable
   * over a wire, because there is nothing to hand over.
   */
  onIncomingCall(handler: (call: Call) => Promise<void> | void): void {
    void (async () => {
      const leg = await this._bind();
      if (!(leg instanceof InProcessLeg)) {
        throw new Error(
          "onIncomingCall() is only for an agent running in this process. " +
            "This connection reaches its agent over a wire, so there is no " +
            "Call to hand over.",
        );
      }
      await handler(new Call(leg));
      leg.close();
    })();
  }

  /**
   * Resolves once the interface is up and `address` can be read.
   *
   * The same three beats as any Node server: start it, await readiness, read
   * the address. Nothing is provisioned before a simulation starts, so a
   * number that costs money is never reserved for a run that never happens.
   */
  async ready(): Promise<void> {
    await this._bind();
  }

  /** @internal Idempotent. The simulation calls this; nothing else should. */
  _bind(): Promise<AgentLeg> {
    if (!this.binding) this.binding = this.open();
    return this.binding;
  }

  /** @internal */
  _record(summary: Summary): void {
    this._summary = summary;
  }

  /** @internal Which way the conversation goes, from the agent's view. */
  get _direction(): "inbound" | "outbound" {
    return this.spec.kind === "host" ? "outbound" : "inbound";
  }

  private async open(): Promise<AgentLeg> {
    if (this.spec.kind === "in-process") {
      this._address = makeAddress("in-process", {});
      this.leg = new InProcessLeg();
      return this.leg;
    }

    if (this.spec.kind === "connect") {
      const via = this.spec.via;
      // The agent is a command rather than a coordinate: spawn it and talk
      // prompt turns, instead of dialling something already listening.
      if ("acp" in via) {
        const leg = new AcpLeg(via.acp);
        await leg.start();
        this._address = makeAddress("acp", { command: via.acp.command });
        this.leg = leg;
        return leg;
      }
      const url = coordinate(via);
      const leg = new ClientLeg(url);
      await leg.connect();
      this._address = makeAddress("websocket", { url });
      this.leg = leg;
      return leg;
    }

    // Hosting: we serve, and the address is what the agent is told to reach.
    const leg = new ServerLeg();
    const url = await leg.serve();
    const iface = this.spec.via;
    if (iface === "phone") {
      // The fake network keeps the mapping, so a dialler can find us.
      this._address = makeAddress("phone", {
        url,
        phoneNumber: registerFakeNumber(url),
      });
    } else if (iface === "sip") {
      this._address = makeAddress("sip", {
        url,
        uri: url.replace("tcp://", "sip:"),
      });
    } else {
      this._address = makeAddress(iface, { url });
    }
    this.leg = leg;
    return leg;
  }

  /** @internal */
  get _leg(): AgentLeg | null {
    return this.leg;
  }
}

/** Describes where a waiting agent is. Nothing is dialled until `simulate()`. */
export function connect(options: ConnectOptions): Connection {
  return new Connection({
    kind: "connect",
    via: options.via,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * Describes an interface to stand up for an agent that will arrive.
 *
 * With no interface named, the agent is a function in this process and gets a
 * `Call` instead of a wire. See the appendix in the design doc.
 */
export function host(options: HostOptions = {}): Connection {
  return options.via
    ? new Connection({ kind: "host", via: options.via })
    : new Connection({ kind: "in-process" });
}
