/**
 * The simulated caller.
 *
 * `dial()` places the call. `waitForCall()` waits to be called. Between them
 * they decide direction, independently of how the agent's end is attached.
 */

import { InProcessLeg, ClientLeg, ServerLeg } from "./legs";
import { makeAddress } from "./address";
import { registerFakeNumber } from "./phone";
import { ActorBrain, Room } from "./room";
import { DialOptions, DialTarget, RoomOptions } from "./types";

let counter = 0;

/** Where a room's agent-side leg comes from, given how it is reached. */
export async function buildRoom(
  options: RoomOptions & { transport?: "websocket" | "phone" | "sip" } = {},
  target?: DialTarget,
  direction: "inbound" | "outbound" = "inbound",
): Promise<Room> {
  const id = `room-${++counter}`;

  // Calls to the agent: we are the client, so we dial out.
  if (target) {
    const url =
      "url" in target
        ? target.url
        : "uri" in target
          ? target.uri
          : // A number we can only reach because the fake network knows it.
            (await import("./phone")).resolveFakeNumber(target.phoneNumber);
    const leg = new ClientLeg(url);
    await leg.connect();
    return new Room({
      id,
      options,
      leg,
      direction,
      address: makeAddress("websocket", { url }),
    });
  }

  // Calls from the agent: we are the one being dialled, so we serve.
  if (options.protocol || options.transport) {
    const leg = new ServerLeg();
    const url = await leg.serve();
    let address = makeAddress("websocket", { url });
    if (options.transport === "phone") {
      // The fake network keeps the mapping, so a dialler can find us.
      address = makeAddress("phone", {
        url,
        phoneNumber: registerFakeNumber(url),
      });
    } else if (options.transport === "sip") {
      address = makeAddress("sip", { url, uri: url.replace("tcp://", "sip:") });
    }
    return new Room({ id, options, leg, address, direction });
  }

  // Nothing said where the agent is, so it must be in this process.
  return new Room({
    id,
    options,
    leg: new InProcessLeg(),
    address: makeAddress("in-process", {}),
    direction,
  });
}

export class Actor {
  constructor(
    readonly slug: string,
    /** @internal A factory, so a second call gets a fresh script. */
    readonly _makeBrain: () => ActorBrain,
    /** @internal */ readonly _speaksFirst: "agent" | "actor",
  ) {}

  /**
   * Place the call.
   *
   * `target` is an address when the agent is somewhere else, or a `Room` when
   * the agent is coming to us. Returns the `Room` the call happened in.
   */
  async dial(
    target: DialTarget | Room,
    options: DialOptions = {},
  ): Promise<Room> {
    if (target instanceof Room) {
      target._attach(this._makeBrain(), this._speaksFirst);
      return target;
    }
    const room = await buildRoom(options, target);
    room._attach(this._makeBrain(), this._speaksFirst);
    return room;
  }

  /** Join a new room and wait for the agent to call. */
  async waitForCall(
    options: RoomOptions & { transport?: "websocket" | "phone" | "sip" } = {},
  ): Promise<Room> {
    // Default to a phone number, because an agent placing a call is the case
    // where a customer is most likely to have only a dialler.
    const room = await buildRoom(
      { transport: "phone", ...options },
      undefined,
      "outbound",
    );
    room._attach(this._makeBrain(), this._speaksFirst);
    return room;
  }
}
