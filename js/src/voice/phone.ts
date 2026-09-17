/**
 * LABELLED FAKE. A process-local stand-in for the phone network.
 *
 * A room asked for a `phone` address has no way to get a real number here, so
 * it registers a fake one against the WebSocket it is actually serving. A mock
 * platform "dials" the number by looking it up. Real telephony replaces this
 * table and nothing above it changes.
 */

const numbers = new Map<string, string>();
let next = 100;

export function registerFakeNumber(url: string): string {
  const phoneNumber = `+1555000${String(next++).padStart(4, "0")}`;
  numbers.set(phoneNumber, url);
  return phoneNumber;
}

/**
 * Resolve a fake number to the WebSocket behind it.
 *
 * Exported so a test double for a voice platform can place a call. Nothing in
 * production should ever need this.
 */
export function resolveFakeNumber(phoneNumber: string): string {
  const url = numbers.get(phoneNumber);
  if (!url) {
    throw new Error(
      `No room is listening on ${phoneNumber}. This is the fake phone ` +
        `network in braintrust/voice, not a real number.`,
    );
  }
  return url;
}

export function clearFakeNumbers(): void {
  numbers.clear();
}
