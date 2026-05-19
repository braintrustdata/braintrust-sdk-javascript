import { expect } from "vitest";
import type { CapturedLogEvent } from "../../helpers/mock-braintrust-server";
import { findChildSpans, findLatestSpan } from "../../helpers/trace-selectors";

function findNamedChildSpan(
  capturedEvents: CapturedLogEvent[],
  names: string[],
  parentId: string | undefined,
) {
  for (const name of names) {
    const span = findChildSpans(capturedEvents, name, parentId)[0];
    if (span) {
      return span;
    }
  }

  return undefined;
}

export function assertLangchainTraces(options: {
  capturedEvents: CapturedLogEvent[];
  rootName: string;
  scenarioName: string;
}): CapturedLogEvent[] {
  const root = findLatestSpan(options.capturedEvents, options.rootName);
  const invokeOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-invoke-operation",
  );
  const chainOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-chain-operation",
  );
  const streamOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-stream-operation",
  );
  const toolOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-tool-operation",
  );
  const toolResultOperation = findLatestSpan(
    options.capturedEvents,
    "langchain-tool-result-operation",
  );

  expect(root).toBeDefined();
  expect(invokeOperation).toBeDefined();
  expect(chainOperation).toBeDefined();
  expect(streamOperation).toBeDefined();
  expect(toolOperation).toBeDefined();
  expect(toolResultOperation).toBeDefined();

  expect(root?.row.metadata).toMatchObject({
    scenario: options.scenarioName,
  });

  for (const operation of [
    invokeOperation,
    chainOperation,
    streamOperation,
    toolOperation,
    toolResultOperation,
  ]) {
    expect(operation?.span.parentIds).toEqual([root?.span.id ?? ""]);
  }

  const invokeSpan = findNamedChildSpan(
    options.capturedEvents,
    ["ChatOpenAI"],
    invokeOperation?.span.id,
  );
  expect(invokeSpan).toBeDefined();
  expect(invokeSpan?.span.type).toBe("llm");

  const chainChildren = findChildSpans(
    options.capturedEvents,
    "RunnableSequence",
    chainOperation?.span.id,
  );
  expect(chainChildren.length).toBeGreaterThanOrEqual(1);

  const streamSpan = findNamedChildSpan(
    options.capturedEvents,
    ["ChatOpenAI"],
    streamOperation?.span.id,
  );
  expect(streamSpan).toBeDefined();
  expect(streamSpan?.span.type).toBe("llm");
  expect(streamSpan?.metrics).toMatchObject({
    time_to_first_token: expect.any(Number),
  });

  const toolSpan = findNamedChildSpan(
    options.capturedEvents,
    ["ChatOpenAI"],
    toolOperation?.span.id,
  );
  expect(toolSpan).toBeDefined();

  const toolOutputStr = JSON.stringify(toolSpan?.output ?? {});
  expect(toolOutputStr).toContain("get_weather");

  const toolResultSpans = findChildSpans(
    options.capturedEvents,
    "ChatOpenAI",
    toolResultOperation?.span.id,
  );
  expect(toolResultSpans.length).toBeGreaterThanOrEqual(2);

  return options.capturedEvents;
}
