/**
 * Utilities for instrumentation hook naming and management.
 */

/**
 * Channel naming convention: braintrust:{component}:{operation}
 *
 * Examples:
 * - braintrust:openai:chat.completions.create
 * - braintrust:anthropic:messages.create
 * - braintrust:ai-sdk:generateText
 */

/**
 * Creates a standardized channel name.
 *
 * @param component - The SDK/library being instrumented (e.g., 'openai', 'anthropic')
 * @param operation - The operation being traced (e.g., 'chat.completions.create')
 * @returns The full channel name
 */
export function createChannelName(
  component: string,
  operation: string,
): string {
  return `braintrust:${component}:${operation}`;
}

/**
 * Parses a channel name into its component parts.
 *
 * @param channelName - The full channel name
 * @returns Object with component and operation, or null if invalid
 */
export function parseChannelName(
  channelName: string,
): { component: string; operation: string } | null {
  const match = channelName.match(/^braintrust:([^:]+):(.+)$/);
  if (!match) {
    return null;
  }
  return {
    component: match[1],
    operation: match[2],
  };
}

/**
 * Validates a channel name follows the expected convention.
 *
 * @param channelName - The channel name to validate
 * @returns True if valid
 */
export function isValidChannelName(channelName: string): boolean {
  return /^braintrust:[^:]+:.+$/.test(channelName);
}
