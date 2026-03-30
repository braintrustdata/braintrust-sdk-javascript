import { initLogger } from "braintrust";

const DEFAULT_PROJECT_NAME = "sdk-e2e-tests";

export interface ProdForwarding {
  apiKey: string;
  apiUrl: string;
  appUrl: string;
  projectId: string;
  projectName: string;
}

let prodForwarding: ProdForwarding | null = null;

export function getProdForwarding(): ProdForwarding | null {
  return prodForwarding;
}

export async function initializeProdForwarding(): Promise<void> {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  if (!apiKey) {
    prodForwarding = null;
    return;
  }

  const projectName =
    process.env.BRAINTRUST_E2E_PROJECT_NAME || DEFAULT_PROJECT_NAME;
  const logger = initLogger({
    apiKey,
    appUrl: process.env.BRAINTRUST_APP_URL,
    asyncFlush: false,
    forceLogin: true,
    projectName,
  });
  const projectId = await logger.id;
  const state = logger.loggingState;

  if (!state.apiUrl || !state.appUrl) {
    throw new Error("Braintrust login did not resolve prodForwarding URLs");
  }

  prodForwarding = {
    apiKey,
    apiUrl: state.apiUrl,
    appUrl: state.appUrl,
    projectId,
    projectName,
  };
}
