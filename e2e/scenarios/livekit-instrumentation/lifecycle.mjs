// Synthetic lifecycle inputs on the installed framework classes. No provider
// calls or fabricated provider responses; this is private-hook regression coverage.
import "./configure.mjs";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { initLogger, wrapLiveKit } from "braintrust";
import { scopedName } from "../../helpers/provider-runtime.mjs";
import { dispose } from "@livekit/rtc-node";
const agents = await import("@livekit/agents");
const { voice, initializeLogger, llm } =
  process.env.LIVEKIT_WRAP === "1" ? wrapLiveKit(agents) : agents;
initializeLogger({ pretty: false, level: "silent" });
const logger = initLogger({ projectName: scopedName("livekit-eou-lifecycle") });
const realNow = Date.now;
let now = realNow() + 10000;
const cases = [];

async function probe(name, run) {
  const session = new voice.AgentSession({
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
  });
  let input;
  session.input.audio = new (class extends voice.AudioInput {
    source = new ReadableStream({
      start(controller) {
        input = controller;
      },
    });
    get stream() {
      return this.source;
    }
    async close() {
      input.close();
    }
  })();
  await session.start({
    agent: new voice.Agent({ instructions: "Lifecycle probe" }),
    record: false,
  });
  const recognition = session.activity.audioRecognition;
  assert.ok(recognition, "exercise the installed AudioRecognition");
  session.sessionSpan.setAttribute("lk.probe.case", name);
  // Replace application acceptance/model callbacks, leaving all framework
  // timestamp assignments, VAD dispatch, wait factories, and cleanup intact.
  recognition.hooks.onEndOfTurn = async () => true;
  recognition.hooks.onPreemptiveGeneration = () => {};
  recognition.hooks.onFinalTranscript = () => {};
  recognition.hooks.retrieveChatCtx = () => new llm.ChatContext();
  recognition.stt = () => {};
  Date.now = () => now;
  try {
    await run(recognition);
  } finally {
    input.close();
    await session.close();
    Date.now = realNow;
  }
  cases.push(name);
  now += 10000;
}

try {
  await probe("synchronous-stt", async (recognition) => {
    const at = now - 2000;
    recognition.processSTTEvent({
      type: 2,
      speechEndTime: at,
      alternatives: [
        {
          text: "Complete turn",
          startTime: 0,
          endTime: 0,
          language: "en",
          confidence: 1,
        },
      ],
    });
    await tick();
    assert.equal(
      recognition.eouWaitSpan,
      undefined,
      "framework committed the wait",
    );
    console.log(JSON.stringify({ probe: "synchronous-stt", start: at / 1000 }));
  });

  for (const ending of ["commit", "shutdown", "drop"]) {
    await probe(`transcription-pending-${ending}`, async (recognition) => {
      const base = now - 5000;
      let feed;
      const queue = new ReadableStream({
        start(controller) {
          feed = controller;
        },
      });
      const vad = {
        stream: () => ({
          updateInputStream() {},
          detachInputStream() {},
          close() {},
          [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
        }),
      };
      recognition.vad = vad;
      const task = recognition.createVadTask(vad, new AbortController().signal);
      const emit = async (type, at, fields = {}) => {
        now = at;
        feed.enqueue({
          type,
          frames: [],
          speechDuration: 0,
          silenceDuration: 0,
          inferenceDuration: 0,
          ...fields,
        });
        await tick();
      };
      await emit(0, base + 1000);
      await emit(2, base + 2100, {
        silenceDuration: 80,
        inferenceDuration: 20,
      });
      // Repeat the actual evaluation: the same transcription-gated pause remains open.
      recognition.runEOUDetection(new llm.ChatContext(), "vad");
      assert.equal(
        recognition.eouWaitSpan,
        undefined,
        "native transcript guard skipped factory",
      );
      await emit(0, base + 2400, { speechDuration: 80, inferenceDuration: 20 });
      await emit(2, base + 3600, {
        silenceDuration: 80,
        inferenceDuration: 20,
      });
      assert.equal(recognition.eouWaitSpan, undefined);
      if (ending === "commit") {
        now = base + 4000;
        recognition.processSTTEvent({
          type: 2,
          alternatives: [
            {
              text: "Later transcript",
              startTime: 0,
              endTime: 0,
              language: "en",
              confidence: 1,
            },
          ],
        });
        await tick();
        assert.equal(
          recognition.eouWaitSpan,
          undefined,
          "later transcript committed existing pause",
        );
      } else if (ending === "drop") {
        now = base + 4000;
        recognition.clearUserTurn();
      }
      feed.close();
      await task;
      console.log(
        JSON.stringify({
          probe: `transcription-pending-${ending}`,
          base: base / 1000,
        }),
      );
    });
  }
} finally {
  Date.now = realNow;
  await logger.flush();
  await dispose();
}
assert.equal(cases.length, 4);
