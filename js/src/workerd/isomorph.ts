import type { Common } from "../isomorph-base";
export type { CallerLocation, IsoAsyncLocalStorage } from "../isomorph-base";
import { createWorkerdIsomorph } from "./platform";
const iso: Common = /* @__PURE__ */ createWorkerdIsomorph();
export default iso;
