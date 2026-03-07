import {
  BraintrustState,
  FullLoginOptions,
  _internalGetGlobalState,
} from "./logger";

export interface PromptEnvironmentAssociation {
  id: string;
  object_type: string;
  object_id: string;
  object_version: string;
  environment_slug: string;
  created: string;
}

export type ListPromptEnvironmentsOptions = FullLoginOptions & {
  promptId: string;
  state?: BraintrustState;
};

export type SetPromptEnvironmentOptions = FullLoginOptions & {
  promptId: string;
  environmentSlug: string;
  version: string;
  state?: BraintrustState;
};

export type ClearPromptEnvironmentOptions = FullLoginOptions & {
  promptId: string;
  environmentSlug: string;
  state?: BraintrustState;
};

/**
 * List all environment associations for a prompt.
 *
 * @param options Options for the request
 * @param options.promptId The ID of the prompt to list environment associations for
 * @param options.apiKey The API key to use. If not specified, will use the `BRAINTRUST_API_KEY` environment variable.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.orgName (Optional) The name of a specific organization to connect to.
 * @returns A list of environment associations for the prompt
 *
 * @example
 * ```javascript
 * const associations = await listPromptEnvironments({
 *   promptId: "prompt-uuid",
 * });
 * console.log(associations);
 * // [{ environment_slug: "production", object_version: "123", ... }]
 * ```
 */
export async function listPromptEnvironments({
  promptId,
  appUrl,
  apiKey,
  orgName,
  fetch,
  forceLogin,
  state: stateArg,
}: ListPromptEnvironmentsOptions): Promise<PromptEnvironmentAssociation[]> {
  const state = stateArg ?? _internalGetGlobalState();

  await state.login({
    orgName,
    apiKey,
    appUrl,
    fetch,
    forceLogin,
  });

  const response = await state
    .apiConn()
    .get_json(
      `environment-object/prompt/${promptId}`,
      orgName ? { org_name: orgName } : {},
    );

  return (response.objects ?? []) as PromptEnvironmentAssociation[];
}

/**
 * Set (or update) the prompt version associated with an environment.
 * If an association already exists, it will be updated. Otherwise, a new one will be created.
 *
 * @param options Options for the request
 * @param options.promptId The ID of the prompt
 * @param options.environmentSlug The environment slug to set (e.g., "production", "staging")
 * @param options.version The version (xact_id) of the prompt to associate with this environment
 * @param options.apiKey The API key to use. If not specified, will use the `BRAINTRUST_API_KEY` environment variable.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.orgName (Optional) The name of a specific organization to connect to.
 * @returns The created or updated environment association
 *
 * @example
 * ```javascript
 * // Associate prompt version "456" with the "production" environment
 * const association = await setPromptEnvironment({
 *   promptId: "prompt-uuid",
 *   environmentSlug: "production",
 *   version: "456",
 * });
 * ```
 */
export async function setPromptEnvironment({
  promptId,
  environmentSlug,
  version,
  appUrl,
  apiKey,
  orgName,
  fetch,
  forceLogin,
  state: stateArg,
}: SetPromptEnvironmentOptions): Promise<PromptEnvironmentAssociation> {
  const state = stateArg ?? _internalGetGlobalState();

  await state.login({
    orgName,
    apiKey,
    appUrl,
    fetch,
    forceLogin,
  });

  // Use PUT for upsert behavior - need to use state.fetch since HTTPConnection doesn't have put method
  const apiConn = state.apiConn();
  const url = `${apiConn.base_url}/environment-object/prompt/${promptId}/${environmentSlug}`;
  const resp = await state.fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(apiConn.token ? { Authorization: `Bearer ${apiConn.token}` } : {}),
    },
    body: JSON.stringify({
      object_version: version,
      ...(orgName && { org_name: orgName }),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${resp.statusText} (${text})`);
  }

  return (await resp.json()) as PromptEnvironmentAssociation;
}

/**
 * Clear an environment association for a prompt.
 *
 * @param options Options for the request
 * @param options.promptId The ID of the prompt
 * @param options.environmentSlug The environment slug to delete (e.g., "production", "staging")
 * @param options.apiKey The API key to use. If not specified, will use the `BRAINTRUST_API_KEY` environment variable.
 * @param options.appUrl The URL of the Braintrust App. Defaults to https://www.braintrust.dev.
 * @param options.orgName (Optional) The name of a specific organization to connect to.
 * @returns The cleared environment association
 * @throws If no association exists for the prompt and environment
 *
 * @example
 * ```javascript
 * // Remove the "staging" environment association
 * await clearPromptEnvironment({
 *   promptId: "prompt-uuid",
 *   environmentSlug: "staging",
 * });
 * ```
 */
export async function clearPromptEnvironment({
  promptId,
  environmentSlug,
  appUrl,
  apiKey,
  orgName,
  fetch,
  forceLogin,
  state: stateArg,
}: ClearPromptEnvironmentOptions): Promise<PromptEnvironmentAssociation> {
  const state = stateArg ?? _internalGetGlobalState();

  await state.login({
    orgName,
    apiKey,
    appUrl,
    fetch,
    forceLogin,
  });

  // Need to use state.fetch since HTTPConnection doesn't have delete method
  const apiConn = state.apiConn();
  const queryString = orgName ? `?org_name=${encodeURIComponent(orgName)}` : "";
  const url = `${apiConn.base_url}/environment-object/prompt/${promptId}/${environmentSlug}${queryString}`;
  const resp = await state.fetch(url, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      ...(apiConn.token ? { Authorization: `Bearer ${apiConn.token}` } : {}),
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${resp.statusText} (${text})`);
  }

  return (await resp.json()) as PromptEnvironmentAssociation;
}
