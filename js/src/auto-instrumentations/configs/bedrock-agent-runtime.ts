// Bedrock Runtime and Bedrock Agent Runtime both inherit Client.send from
// Smithy. Reuse the same transformer configs and dispatch by command name in
// their respective plugins.
export { bedrockRuntimeConfigs as bedrockAgentRuntimeConfigs } from "./bedrock-runtime";
