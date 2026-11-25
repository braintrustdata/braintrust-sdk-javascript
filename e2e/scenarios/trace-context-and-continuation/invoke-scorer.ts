import scorer from "./scorer";
import { runMain } from "../../helpers/scenario-runtime";

runMain(async () => {
  if ((await scorer({ input: "question", output: 1, expected: 1 })) !== 1) {
    throw new Error("Unexpected score");
  }
});
