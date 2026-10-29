import type { Common } from "../isomorph-base";
export type { CallerLocation, IsoAsyncLocalStorage } from "../isomorph-base";
import { createEdgeLightIsomorph } from "./platform";
const iso: Common = /* @__PURE__ */ createEdgeLightIsomorph();
export default iso;
