/** Owns PCM reservations across staging, recorder admission and worker transfer. */
export class PcmBuffers {
  private leases = new Map<
    ArrayBufferLike,
    { bytes: number; admitted: boolean }
  >();
  private retained = 0;
  constructor(private maximum: number) {}
  get bytes() {
    return this.retained;
  }
  copy(pcm: Int16Array): Int16Array {
    const bytes = pcm.byteLength;
    if (this.retained + bytes > this.maximum) {
      throw new Error("capture_byte_limit");
    }
    const owned = new Int16Array(pcm);
    this.leases.set(owned.buffer, { bytes, admitted: false });
    this.retained += bytes;
    return owned;
  }

  admit(pcm: Int16Array): boolean {
    const lease = this.leases.get(pcm.buffer);
    if (!lease || lease.admitted) {
      return false;
    }
    lease.admitted = true;
    return true;
  }
  discard(pcm: Int16Array) {
    if (!this.leases.get(pcm.buffer)?.admitted) {
      this.release(pcm);
    }
  }
  release(pcm: Int16Array) {
    const lease = this.leases.get(pcm.buffer);
    if (!lease) {
      return;
    }
    this.leases.delete(pcm.buffer);
    this.retained -= lease.bytes;
  }
  split(pcm: Int16Array, count: number): [Int16Array, Int16Array] {
    const lease = this.leases.get(pcm.buffer);
    if (!lease || pcm.byteLength !== lease.bytes) {
      throw new Error("Invalid PCM ownership");
    }
    const head = pcm.slice(0, count),
      tail = pcm.slice(count);
    this.leases.delete(pcm.buffer);
    this.leases.set(head.buffer, { bytes: head.byteLength, admitted: true });
    this.leases.set(tail.buffer, { bytes: tail.byteLength, admitted: true });
    return [head, tail];
  }
  close() {
    this.leases.clear();
    this.retained = 0;
  }
}
