import type { IncomingMessage } from "node:http";

/** Count complete Connect envelopes without retaining their payloads. */
export function trackConnectRequest(req: IncomingMessage) {
  const header = Buffer.alloc(5);
  let headerSize = 0;
  let remaining = 0;
  let frames = 0;
  let closed = false;
  let notify = () => {};

  const onData = (data: Buffer) => {
    let offset = 0;
    while (offset < data.length) {
      if (headerSize < header.length) {
        const size = Math.min(header.length - headerSize, data.length - offset);
        data.copy(header, headerSize, offset, offset + size);
        headerSize += size;
        offset += size;
        if (headerSize < header.length) continue;
        remaining = header.readUInt32BE(1);
      }
      const size = Math.min(remaining, data.length - offset);
      remaining -= size;
      offset += size;
      if (remaining === 0) {
        frames++;
        headerSize = 0;
      }
    }
    notify();
  };
  const onClose = () => {
    closed = true;
    notify();
  };
  req.on("data", onData);
  req.on("end", onClose);
  req.on("close", onClose);
  req.on("error", onClose);

  return {
    get frames() {
      return frames;
    },
    // Response stream pulls are sequential, so there is only one waiter.
    async waitFor(count: number) {
      while (frames < count) {
        if (closed) {
          throw new Error(
            `Connect request ended after ${frames} frames; replay requires ${count}`,
          );
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    dispose() {
      req.off("data", onData);
      req.off("end", onClose);
      req.off("close", onClose);
      req.off("error", onClose);
      onClose();
    },
  };
}
