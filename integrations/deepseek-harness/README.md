# Braintrust for DeepSeek Harness

Trace each DeepSeek Harness user turn, model call, and tool execution in
Braintrust. Each top-level user turn is reported as its own trace, even when
multiple turns belong to the same Harness session.

## Install

```bash
export BRAINTRUST_API_KEY=<your-api-key>
dsh plugin --profile web add @braintrust/deepseek-harness
```

The command installs the package and activates its bundled Cordis patch for the
`web` profile. Replace `web` with the Harness profile you want to instrument.
The plugin reads `BRAINTRUST_API_KEY` when no API key is configured in Harness.

## Configure

To override the defaults, add the following entry to the profile's
`cordis.patch.yml`:

```yaml
- id: braintrust
  config:
    apiKey: <your-api-key>
    projectName: DeepSeek Harness
    metadata:
      environment: production
```

The optional configuration fields are `apiKey`, `projectName`, `metadata`,
`orgName`, and `appUrl`. `metadata` is added to every top-level user-turn trace,
and `projectName` defaults to `DeepSeek Harness`. You can set `apiKey`
under **Settings > Plugins** in Harness; it is declared as a secret field so
the settings UI handles it as a credential. A configured `apiKey` takes
precedence over the `BRAINTRUST_API_KEY` environment variable.
