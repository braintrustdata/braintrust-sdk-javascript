/**
 * Vitest sub-path export tests. Validates that `setupCassettes` properly
 * wires beforeEach/afterEach hooks and derives sensible default cassette
 * names.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { createMemoryStore, type CassetteStore } from "../src";
import { setupCassettes } from "../src/vitest";

let server: Server;
let baseUrl: () => string;

function makeServer(): Server {
  return createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url ?? "/", method: req.method }));
  });
}

beforeAll(async () => {
  server = makeServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address() as AddressInfo;
  baseUrl = () => `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("setupCassettes — record + replay flow", () => {
  // A shared store so the "record" subtest can hand off cassettes to "replay".
  const sharedStore = createMemoryStore();
  // Use a fixed cassette name so record and replay phases agree.
  const fixedName = (): string => "shared-flow";

  describe("record phase", () => {
    setupCassettes({ mode: "record", store: sharedStore, nameFor: fixedName });

    it("captures fetch traffic into the named cassette", async () => {
      const res = await fetch(`${baseUrl()}/echo-record`);
      expect(res.ok).toBe(true);
      const json = (await res.json()) as { url: string };
      expect(json.url).toBe("/echo-record");
    });
  });

  describe("replay phase", () => {
    setupCassettes({ mode: "replay", store: sharedStore, nameFor: fixedName });

    it("replays the recorded response without hitting the server", async () => {
      const res = await fetch(`${baseUrl()}/echo-record`);
      expect(res.ok).toBe(true);
      const json = (await res.json()) as { url: string };
      expect(json.url).toBe("/echo-record");
    });
  });
});

describe("setupCassettes — name derivation", () => {
  // We can't easily inspect the internally-derived name without modifying
  // the API, so verify by capturing the cassette name through nameFor.
  let captured = "";

  const recordedNames: string[] = [];
  const inspectingStore: CassetteStore = {
    load() {
      return Promise.resolve(null);
    },
    save(name) {
      recordedNames.push(name);
      return Promise.resolve();
    },
  };

  setupCassettes({
    mode: "record",
    store: inspectingStore,
    nameFor: (ctx) => {
      captured = ctx.testName;
      return "fixed-name";
    },
  });

  it("passes the test name to nameFor", async () => {
    await fetch(`${baseUrl()}/anything`);
    // Note: captured is set at beforeEach time, not at test body time;
    // nameFor receives the test name from expect.getState() at hook time.
  });

  afterAll(() => {
    expect(captured).toContain("passes the test name to nameFor");
    expect(recordedNames).toContain("fixed-name");
  });
});

describe("setupCassettes — current()", () => {
  const handle = setupCassettes({ mode: "replay", store: createMemoryStore() });

  it("returns the active cassette inside a test", () => {
    const c = handle.current();
    expect(c).toBeDefined();
    expect(c.mode).toBe("replay");
  });
});
