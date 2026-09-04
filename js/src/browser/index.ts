/**
 * Browser-compatible build of the Braintrust SDK.
 *
 * This build uses a noop isomorph that provides browser-safe implementations
 * for Node.js-specific features.
 *
 * For optimal browser support with AsyncLocalStorage polyfill, consider:
 *   npm install @braintrust/browser
 *   import * as braintrust from '@braintrust/browser';
 */

import { configureBrowser } from "./config";

configureBrowser();

export * from "../exports";
