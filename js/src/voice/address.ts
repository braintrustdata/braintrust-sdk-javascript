/**
 * A room's address.
 *
 * The accessors are typed as always present but throw when the transport has
 * nothing to offer, so reading `room.address.url` on a phone room is a loud
 * error rather than a silent `undefined` flowing onward.
 */

import { RoomAddress } from "./types";

export function makeAddress(
  transport: RoomAddress["transport"],
  values: { url?: string; phoneNumber?: string; uri?: string },
): RoomAddress {
  const need = (name: keyof typeof values) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(
        `This room's address is a ${transport} address, so it has no ` +
          `${String(name)}. Create the room with the transport you intend to ` +
          `hand out.`,
      );
    }
    return value;
  };
  return {
    transport,
    get url() {
      return need("url");
    },
    get phoneNumber() {
      return need("phoneNumber");
    },
    get uri() {
      return need("uri");
    },
  };
}
