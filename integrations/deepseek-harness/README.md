# Braintrust for DeepSeek Harness

Trace each DeepSeek Harness user turn, model call, and tool execution in
Braintrust. Each top-level user turn is reported as its own trace, even when
multiple turns belong to the same Harness session.

## Install

```bash
npm install @braintrust/deepseek-harness
```

Set `BRAINTRUST_API_KEY`, then add the plugin to your Harness profile patch:

```yaml
- insert:
    - id: braintrust
      name: "@braintrust/deepseek-harness"
      config:
        projectName: DeepSeek Harness
```

The optional configuration fields are `projectName`, `orgName`, and `appUrl`.
`projectName` defaults to `DeepSeek Harness`. Authentication always uses the
standard Braintrust environment configuration; API keys are not accepted in
the YAML configuration.
