import { createServer } from "node:http";
import { z } from "zod/v3";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "stagehand-instrumentation-root";
export const SCENARIO_NAME = "stagehand-instrumentation";
export const SECRET = "STAGEHAND_PRIVATE_SECRET";
export const MODEL_NAME = "gpt-4o-mini-2024-07-18";
export const ADD_TO_CART_INSTRUCTION = "Add the Trail Backpack to the cart";

const SHOP_HTML = `<!doctype html>
<html>
  <head><title>Trail Supply</title></head>
  <body>
    <main>
      <h1>Trail Backpack</h1>
      <p id="price">$129.00</p>
      <button id="add-to-cart" onclick="document.querySelector('#cart').textContent = '1 Trail Backpack — $129.00'">
        Add to cart
      </button>
      <section aria-label="Shopping cart">
        <p id="cart">Cart is empty</p>
        <button id="checkout">Checkout</button>
      </section>
    </main>
  </body>
</html>`;

async function startShopServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(SHOP_HTML);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the Stagehand shop server to use a TCP port");
  }
  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    url: `http://127.0.0.1:${address.port}/products/trail-backpack`,
  };
}

async function createStagehandSession(Stagehand, instrumentedAI) {
  const stagehand = new Stagehand({
    disablePino: true,
    env: "LOCAL",
    localBrowserLaunchOptions: {
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
      chromiumSandbox: false,
      executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
      headless: true,
    },
    model: {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      modelName: `openai/${MODEL_NAME}`,
    },
    verbose: 0,
  });
  await stagehand.init();
  const page = stagehand.context.pages()[0];
  if (!page) {
    await stagehand.close({ force: true });
    throw new Error("Expected Stagehand to initialize a Chromium page");
  }
  const languageModel = stagehand.llmClient?.getLanguageModel?.();
  if (!languageModel) {
    await stagehand.close({ force: true });
    throw new Error("Expected Stagehand to create an AI SDK language model");
  }
  stagehand.llmClient.createChatCompletion = async ({ options }) => {
    if (!options.response_model) {
      throw new Error(
        "Expected Stagehand act to request a structured response",
      );
    }
    const response = await instrumentedAI.generateObject({
      allowSystemInMessages: true,
      messages: options.messages,
      model: languageModel,
      schema: options.response_model.schema,
      temperature: options.temperature,
    });
    return {
      data: response.object,
      usage: {
        cached_input_tokens: response.usage.cachedInputTokens ?? 0,
        completion_tokens: response.usage.outputTokens ?? 0,
        prompt_tokens: response.usage.inputTokens ?? 0,
        reasoning_tokens: response.usage.reasoningTokens ?? 0,
        total_tokens: response.usage.totalTokens ?? 0,
      },
    };
  };
  const extractCart = async (instruction) => {
    const cartText = await page.locator("#cart").innerText();
    const quantity = cartText.startsWith("1 ") ? 1 : 0;
    if (!instruction) {
      return `${await page.locator("body").innerText()} ${SECRET}`;
    }
    return {
      item: "Trail Backpack",
      quantity,
      total: quantity === 1 ? "$129.00" : "$0.00",
      cacheStatus: "MISS",
    };
  };
  Object.assign(stagehand, {
    _history: [],
    actCache: { enabled: false },
    agentCache: {
      buildConfigSignature: () => "fixture-signature",
      isRecording: () => false,
      sanitizeExecuteOptions: (options) => options,
      shouldAttemptCache: () => false,
    },
    apiClient: {
      act: async ({ input, options }) => {
        if (input === "Apply the expired coupon code") {
          throw new Error("STAGEHAND_COUPON_NOT_FOUND");
        }
        if (typeof input !== "string") {
          throw new Error("Expected Stagehand act to receive an instruction");
        }
        return stagehand.actHandler.act({
          instruction: input,
          model: options?.model,
          page,
          timeout: options?.timeout,
          variables: options?.variables,
        });
      },
      agentExecute: async () => {
        const cart = await extractCart("cart state");
        return {
          success: true,
          completed: true,
          message:
            "Cart reviewed; checkout is ready for customer confirmation.",
          output: {
            checkoutReady: cart.quantity === 1,
            itemCount: cart.quantity,
          },
          actions: [
            {
              type: "observe",
              taskCompleted: true,
              timeMs: 15,
              selector: SECRET,
              reasoning: SECRET,
            },
          ],
          metadata: { cacheHit: true, debugUrl: SECRET },
          messages: [{ role: "assistant", content: SECRET }],
          usage: {
            input_tokens: 11,
            output_tokens: 5,
            reasoning_tokens: 2,
            cached_input_tokens: 3,
            inference_time_ms: 250,
          },
        };
      },
      consumeLatestAgentCacheEntry: () => undefined,
      end: async () => undefined,
      extract: async ({ instruction }) => extractCart(instruction),
      observe: async () => [
        {
          method: "click",
          selector: SECRET,
          arguments: [SECRET],
          description: SECRET,
        },
      ],
    },
    experimental: false,
    extractHandler: {
      extract: async ({ instruction }) => extractCart(instruction),
    },
    flowLoggerContext: undefined,
    observeHandler: {
      observe: async () => [
        {
          method: "click",
          selector: SECRET,
          arguments: [SECRET],
          description: SECRET,
        },
      ],
    },
    stagehandMetrics: {},
    updateAgentMetricsFromUsage: () => undefined,
  });
  return stagehand;
}

export async function runStagehandInstrumentationScenario(
  sdk,
  ai,
  decorateSDK,
  decorateAI,
) {
  const instrumentedSDK = decorateSDK ? decorateSDK(sdk) : sdk;
  const instrumentedAI = decorateAI ? decorateAI(ai) : ai;
  if (instrumentedSDK.Stagehand !== instrumentedSDK.V3) {
    throw new Error("Expected Stagehand and V3 exports to remain aliases");
  }
  const shopServer = await startShopServer();
  let stagehand;

  try {
    stagehand = await createStagehandSession(
      instrumentedSDK.Stagehand,
      instrumentedAI,
    );
    const page = stagehand.context.pages()[0];
    await page.goto(shopServer.url, {
      timeoutMs: 10_000,
      waitUntil: "domcontentloaded",
    });
    if (page.url() !== shopServer.url) {
      throw new Error("Stagehand did not navigate to the shop page");
    }

    await runTracedScenario({
      callback: async () => {
        await runOperation("stagehand-act-operation", "act", async () => {
          const result = await stagehand.act(ADD_TO_CART_INSTRUCTION, {
            variables: { customerEmail: SECRET },
          });
          if (!result.success) {
            throw new Error("Stagehand did not add the item to the cart");
          }
        });

        await runOperation(
          "stagehand-extract-operation",
          "extract",
          async () => {
            const cart = await stagehand.extract(
              "Extract the cart item, quantity, and total",
              z.object({
                item: z.string(),
                quantity: z.number(),
                total: z.string(),
              }),
            );
            if (cart.item !== "Trail Backpack" || cart.quantity !== 1) {
              throw new Error("Unexpected cart extraction result");
            }
            await stagehand.extract();
          },
        );

        await runOperation(
          "stagehand-observe-operation",
          "observe",
          async () => {
            const actions = await stagehand.observe("Find the checkout button");
            if (actions.length !== 1) {
              throw new Error("Expected one checkout action");
            }
          },
        );

        await runOperation("stagehand-agent-operation", "agent", async () => {
          const agent = stagehand.agent({
            maxSteps: 6,
            mode: "dom",
            model: `openai/${MODEL_NAME}`,
            stream: false,
          });
          const result = await agent.execute({
            instruction:
              "Review the cart and prepare to check out. Stop before submitting payment.",
            variables: { customerEmail: SECRET },
          });
          if (!result.output?.checkoutReady) {
            throw new Error("Unexpected Stagehand agent result");
          }
        });

        await runOperation("stagehand-error-operation", "error", async () => {
          try {
            await stagehand.act("Apply the expired coupon code");
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== "STAGEHAND_COUPON_NOT_FOUND"
            ) {
              throw error;
            }
          }
        });
      },
      flushCount: 2,
      metadata: { scenario: SCENARIO_NAME },
      projectNameBase: "e2e-stagehand-instrumentation",
      rootName: ROOT_NAME,
    });
  } finally {
    await stagehand?.close({ force: true });
    await shopServer.close();
  }
}
