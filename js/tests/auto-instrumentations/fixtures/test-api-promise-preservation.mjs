import { tracingChannel } from "node:diagnostics_channel";
import { parentPort } from "node:worker_threads";

class HelperPromise extends Promise {
  #innerPromise;

  constructor(responsePromise) {
    let resolveOuter;
    super((resolve) => {
      resolveOuter = resolve;
    });
    this.#innerPromise = Promise.resolve(responsePromise);
    this.#innerPromise.then(resolveOuter);
  }

  then(onfulfilled, onrejected) {
    return this.#innerPromise.then(onfulfilled, onrejected);
  }

  async withResponse() {
    return {
      data: await this.#innerPromise,
      response: { ok: true },
    };
  }
}

const channel = tracingChannel("braintrust:test:helper-promise");
const traced = channel.tracePromise(
  () => new HelperPromise(Promise.resolve("ok")),
  {},
);

const withResponse = await traced.withResponse();

parentPort?.postMessage({
  type: "helper-result",
  result: {
    awaitedValue: await traced,
    constructorName: traced.constructor.name,
    hasWithResponse: typeof traced.withResponse === "function",
    withResponseData: withResponse.data,
    withResponseOk: withResponse.response.ok,
  },
});
