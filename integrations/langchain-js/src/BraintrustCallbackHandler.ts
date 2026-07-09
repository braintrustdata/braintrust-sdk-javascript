import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AgentAction, AgentFinish } from "@langchain/core/dist/agents";
import { DocumentInterface } from "@langchain/core/dist/documents/document";
import { Serialized } from "@langchain/core/dist/load/serializable";
import { BaseMessage } from "@langchain/core/dist/messages/base";
import { ChatResult, LLMResult } from "@langchain/core/dist/outputs";
import { ChainValues } from "@langchain/core/dist/utils/types";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BraintrustLangChainCallbackHandler,
  type LangChainCallbackHandlerOptions,
} from "braintrust";

type BraintrustCallbackHandlerOptions<IsAsyncFlush extends boolean> =
  LangChainCallbackHandlerOptions<IsAsyncFlush>;

/**
 * A Braintrust tracer for LangChain.js that logs LLM calls, chains, and tools.
 */
export class BraintrustCallbackHandler<
  IsAsyncFlush extends boolean,
> extends BaseCallbackHandler {
  name = "BraintrustCallbackHandler";
  private inner: BraintrustLangChainCallbackHandler<IsAsyncFlush>;

  constructor(
    options?: Partial<BraintrustCallbackHandlerOptions<IsAsyncFlush>>,
  ) {
    super();
    this.inner = new BraintrustLangChainCallbackHandler<IsAsyncFlush>(options);
  }

  handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: {
      options: RunnableConfig;
      invocation_params?: Record<string, unknown>;
      batch_size: number;
      cache?: boolean;
    },
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.inner.handleLLMStart(
      llm,
      prompts,
      runId,
      parentRunId,
      extraParams,
      tags,
      metadata,
      runName,
    );
  }

  handleLLMError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleLLMError(err, runId, parentRunId, tags);
  }

  handleLLMEnd(
    output: LLMResult | ChatResult,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleLLMEnd(output, runId, parentRunId, tags);
  }

  handleLLMNewToken(
    token: string,
    idx: { prompt: number; completion: number },
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleLLMNewToken(token, idx, runId, parentRunId, tags);
  }

  handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: {
      options: RunnableConfig;
      invocation_params?: Record<string, unknown>;
      batch_size: number;
      cache?: boolean;
    },
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.inner.handleChatModelStart(
      llm,
      messages,
      runId,
      parentRunId,
      extraParams,
      tags,
      metadata,
      runName,
    );
  }

  handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runType?: string,
    runName?: string,
  ): Promise<void> {
    return this.inner.handleChainStart(
      chain,
      inputs,
      runId,
      parentRunId,
      tags,
      metadata,
      runType,
      runName,
    );
  }

  handleChainError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, unknown> },
  ): Promise<void> {
    return this.inner.handleChainError(err, runId, parentRunId, tags, kwargs);
  }

  handleChainEnd(
    outputs: ChainValues,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    kwargs?: { inputs?: Record<string, unknown> },
  ): Promise<void> {
    return this.inner.handleChainEnd(outputs, runId, parentRunId, tags, kwargs);
  }

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    return this.inner.handleToolStart(
      tool,
      input,
      runId,
      parentRunId,
      tags,
      metadata,
      runName,
    );
  }

  handleToolError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleToolError(err, runId, parentRunId, tags);
  }

  handleToolEnd(
    output: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleToolEnd(output, runId, parentRunId, tags);
  }

  handleAgentAction(
    action: AgentAction,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleAgentAction(
      action as unknown as Record<string, unknown>,
      runId,
      parentRunId,
      tags,
    );
  }

  handleAgentEnd(
    action: AgentFinish,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleAgentEnd(action, runId, parentRunId, tags);
  }

  handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    return this.inner.handleRetrieverStart(
      retriever,
      query,
      runId,
      parentRunId,
      tags,
      metadata,
      name,
    );
  }

  handleRetrieverEnd(
    documents: DocumentInterface[],
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleRetrieverEnd(documents, runId, parentRunId, tags);
  }

  handleRetrieverError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> {
    return this.inner.handleRetrieverError(err, runId, parentRunId, tags);
  }
}
