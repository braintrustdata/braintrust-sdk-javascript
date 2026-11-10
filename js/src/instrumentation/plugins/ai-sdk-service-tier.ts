import { isObject } from "../../../util";
import { serviceTierMetadata } from "../core/service-tier";

// These providers expose serviceTier in their language model options/metadata.
const PROVIDERS = ["openai", "azure", "anthropic", "google", "bedrock", "groq"];

export function aiSDKServiceTierMetadata(
  options: unknown,
  direction: "requested" | "served",
  provider?: unknown,
): Record<string, string> {
  if (!isObject(options)) return {};
  const namespace =
    typeof provider === "string" ? provider.split(".")[0] : undefined;
  for (const name of PROVIDERS) {
    if (
      namespace &&
      (namespace === "amazon-bedrock" ? "bedrock" : namespace) !== name
    )
      continue;
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
