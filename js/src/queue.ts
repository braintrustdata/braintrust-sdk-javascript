import { debugLogger } from "./debug-logger";

export const DEFAULT_QUEUE_SIZE = 15000;

// A simple queue that drops new items when full. Uses a plain array
// that can grow for unlimited queues or rejects new items for bounded queues.
export class Queue<T> {
  private items: Array<T> = [];
  private maxSize: number;
  private enforceSizeLimit = false;

  constructor(maxSize: number) {
    if (maxSize < 1) {
      debugLogger.warn(
        `maxSize ${maxSize} is <1, using default ${DEFAULT_QUEUE_SIZE}`,
      );
      maxSize = DEFAULT_QUEUE_SIZE;
    }

    this.maxSize = maxSize;
  }

  /**
   * Set queue size limit enforcement. When enabled, the queue will drop new items
   * when it reaches maxSize. When disabled (default), the queue can grow unlimited.
   */
  enforceQueueSizeLimit(enforce: boolean) {
    this.enforceSizeLimit = enforce;
  }

  push(...items: T[]): T[] {
    const dropped: T[] = [];

    for (const item of items) {
      if (!this.enforceSizeLimit) {
        // For unlimited queues (default), just add items without dropping
        this.items.push(item);
      } else {
        // For bounded queues, drop new items when full
        if (this.items.length >= this.maxSize) {
          dropped.push(item);
        } else {
          this.items.push(item);
        }
      }
    }

    return dropped;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  drain(): T[] {
    const items = [...this.items];
    this.items = [];
    return items;
  }

  drainWhile(predicate: (item: T) => boolean): T[] {
    let end = 0;
    while (end < this.items.length && predicate(this.items[end])) {
      end++;
    }

    const items = this.items.slice(0, end);
    this.items = this.items.slice(end);
    return items;
  }

  clear(): void {
    this.items = [];
  }

  length(): number {
    return this.items.length;
  }

  get capacity(): number {
    return this.maxSize;
  }
}
