import { expect, test } from "vitest";
import { Queue } from "./queue";

test("Queue basic operations", () => {
  const queue = new Queue<number>(3);

  // Enable size limit for this test
  queue.enforceQueueSizeLimit(true);

  // Empty queue
  expect(queue.length()).toBe(0);
  expect(queue.peek()).toBe(undefined);
  expect(queue.drain()).toEqual([]);

  // Fill without overflow
  const dropped1 = queue.push(1, 2, 3);
  expect(dropped1).toEqual([]);
  expect(queue.length()).toBe(3);
  expect(queue.peek()).toBe(1);

  // Overflow behavior - drops new items
  const dropped2 = queue.push(4);
  expect(dropped2).toEqual([4]);
  expect(queue.length()).toBe(3);
  expect(queue.peek()).toBe(1);

  // Drain maintains original order
  const drained = queue.drain();
  expect(drained).toEqual([1, 2, 3]);
  expect(queue.length()).toBe(0);
  expect(queue.peek()).toBe(undefined);
});

test("Queue edge cases", () => {
  // Capacity 1
  const q1 = new Queue<number>(1);
  q1.enforceQueueSizeLimit(true);
  q1.push(1);
  const dropped = q1.push(2);
  expect(dropped).toEqual([2]);
  expect(q1.drain()).toEqual([1]);

  // Negative maxSize defaults to 15000
  const q2 = new Queue<number>(-1);
  q2.enforceQueueSizeLimit(true);
  const items = Array.from({ length: 100 }, (_, i) => i);
  const droppedItems = q2.push(...items);
  expect(droppedItems).toEqual([]);
  expect(q2.length()).toBe(100);
});

test("Queue clear operation", () => {
  const queue = new Queue<number>(5);
  queue.push(1, 2, 3);
  expect(queue.length()).toBe(3);

  queue.clear();
  expect(queue.length()).toBe(0);
  expect(queue.peek()).toBe(undefined);
  expect(queue.drain()).toEqual([]);
});

test("Queue drains a matching prefix", () => {
  const queue = new Queue<number>(5);
  queue.push(1, 2, 3, 4, 5);

  expect(queue.drainWhile((item) => item <= 3)).toEqual([1, 2, 3]);
  expect(queue.drain()).toEqual([4, 5]);
});

test("Queue size limit enforcement per instance", () => {
  const queue1 = new Queue<number>(2);
  const queue2 = new Queue<number>(3);

  // Start with unlimited (default behavior)
  queue1.push(1, 2, 3, 4, 5);
  expect(queue1.length()).toBe(5);

  queue2.push(1, 2, 3, 4, 5);
  expect(queue2.length()).toBe(5);

  // Enable size limit on queue1 only
  queue1.enforceQueueSizeLimit(true);

  // queue1 should now enforce size limit
  const dropped1 = queue1.push(6);
  expect(dropped1).toEqual([6]);
  expect(queue1.length()).toBe(5);

  // queue2 should still be unlimited
  const dropped2 = queue2.push(6, 7, 8);
  expect(dropped2).toEqual([]);
  expect(queue2.length()).toBe(8);

  // Enable size limit on queue2 as well
  queue2.enforceQueueSizeLimit(true);

  // Both queues should now enforce their respective size limits
  queue1.drain(); // Clear queue1
  queue2.drain(); // Clear queue2

  queue1.push(1, 2); // Fill to capacity
  queue2.push(1, 2, 3); // Fill to capacity

  const dropped3 = queue1.push(3);
  expect(dropped3).toEqual([3]);
  expect(queue1.length()).toBe(2);

  const dropped4 = queue2.push(4);
  expect(dropped4).toEqual([4]);
  expect(queue2.length()).toBe(3);
});

test("Queue can toggle size limit enforcement", () => {
  const queue = new Queue<number>(2);

  // Start unlimited (default)
  queue.push(1, 2, 3);
  expect(queue.length()).toBe(3);

  // Enable enforcement
  queue.enforceQueueSizeLimit(true);
  const dropped1 = queue.push(4);
  expect(dropped1).toEqual([4]);
  expect(queue.length()).toBe(3);

  // Disable enforcement
  queue.enforceQueueSizeLimit(false);
  const dropped2 = queue.push(5, 6);
  expect(dropped2).toEqual([]);
  expect(queue.length()).toBe(5);

  // Enable enforcement again
  queue.enforceQueueSizeLimit(true);
  const dropped3 = queue.push(7);
  expect(dropped3).toEqual([7]);
  expect(queue.length()).toBe(5);
});
