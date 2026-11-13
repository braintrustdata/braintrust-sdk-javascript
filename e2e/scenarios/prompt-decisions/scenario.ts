import { initLogger, projects } from "braintrust";
import {
  getTestRunId,
  runMain,
  scopedName,
} from "../../helpers/scenario-runtime";

async function main() {
  const logger = initLogger({
    projectName: scopedName("e2e-prompt-decisions"),
  });
  const project = projects.create({ name: scopedName("e2e-prompt-decisions") });
  const prompt = project.prompts.create({
    name: "decisions",
    model: "decision-model",
    input: [{ role: "user", content: "Evaluate {{text}}" }],
    questions: [
      { type: "predicate", instructions: "Is {{text}} a greeting?" },
      {
        type: "choice",
        instructions: "Choose the category",
        choices: [{ value: "{{category}}" }, { value: false }],
      },
      {
        type: "score",
        instructions: "Rate clarity",
        levels: [{ label: "{{level}}", description: "Very {{level}}" }],
      },
    ],
  });
  const variables = { text: "hello", category: "greeting", level: "clear" };
  await logger.traced(
    async (span) => {
      const built = await prompt.buildWithAttachments(variables, {
        flavor: "decisions",
        strict: true,
      });
      span.log({
        output: {
          model: built.model,
          input: built.input,
          questions: built.questions,
        },
      });
    },
    {
      name: "prompt-decisions",
      event: {
        input: variables,
        metadata: { scenario: "prompt-decisions", testRunId: getTestRunId() },
      },
    },
  );
  await logger.flush();
}

runMain(main);
