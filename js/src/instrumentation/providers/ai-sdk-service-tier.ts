import { isObject } from "../../../util";
import { serviceTierMetadata } from "../core/service-tier";

// These providers expose serviceTier in their language model options/metadata.
const PROVIDERS = ["openai", "azure", "anthropic", "google", "bedrock", "groq"];

export function aiSDKServiceTierMetadata(
  options: unknown,
  direction: "requested" | "served",
  provider?: unknown,
  modelId?: unknown,
): Record<string, string> {
  if (!isObject(options)) return {};
  let namespace =
    typeof provider === "string" ? provider.split(".")[0] : undefined;
  if (namespace === "amazon-bedrock") namespace = "bedrock";
  if (direction === "requested" && namespace === "gateway") {
    const metadata = serviceTierMetadata({
      requested: isObject(options.gateway)
        ? options.gateway.serviceTier
        : undefined,
    });
    if (Object.keys(metadata).length) return metadata;
    namespace =
      typeof modelId === "string" && modelId.includes("/")
        ? modelId.split("/")[0]
        : undefined;
  }
  // Azure Responses falls back to OpenAI options only when Azure options are absent.
  if (
    direction === "requested" &&
    namespace === "azure" &&
    options.azure == null
  )
    namespace = "openai";
  if (direction === "requested" && !namespace) return {};
  for (const name of PROVIDERS) {
    if (namespace && namespace !== name) continue;
    const value = options[name];
    if (!isObject(value)) continue;
    const tier =
      name === "bedrock" &&
      direction === "served" &&
      isObject(value.serviceTier)
        ? value.serviceTier.type
        : (value.serviceTier ??
          (name === "anthropic" && isObject(value.usage)
            ? value.usage.service_tier
            : undefined));
    const metadata = serviceTierMetadata({ [direction]: tier });
    if (Object.keys(metadata).length) return metadata;
  }
  return {};
}
