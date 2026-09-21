/**
 * A hosted connection's address.
 *
 * The accessors are typed as always present but throw when the interface has
 * nothing to offer, so reading `connection.address.url` on a phone line is a
 * loud error rather than a silent `undefined` flowing onward.
 */

import { Address } from "./types";

export function makeAddress(
  iface: Address["interface"],
  values: {
    url?: string;
    phoneNumber?: string;
    uri?: string;
    command?: string;
  },
): Address {
  const need = (name: keyof typeof values) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(
        `This connection is a ${iface} connection, so it has no ` +
          `${String(name)}. Host the interface you intend to hand out.`,
      );
    }
    return value;
  };
  return {
    interface: iface,
    get url() {
      return need("url");
    },
    get phoneNumber() {
      return need("phoneNumber");
    },
    get uri() {
      return need("uri");
    },
    get command() {
      return need("command");
    },
  };
}
