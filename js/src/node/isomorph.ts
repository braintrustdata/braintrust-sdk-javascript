import type { Common } from "../isomorph-base";
export type { CallerLocation, IsoAsyncLocalStorage } from "../isomorph-base";
import { createNodeIsomorph } from "./platform";
const iso: Common = /* @__PURE__ */ createNodeIsomorph();
export default iso;
