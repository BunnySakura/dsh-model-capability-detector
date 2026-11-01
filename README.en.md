# dsh-model-capability-detector

When you add or save a third-party API provider in DSH, this plugin fills in each model's context window, maximum output, image support and reasoning levels so you do not have to type them.

> 中文文档：[README.md](README.md)

## Features

- **Fetch available models** fills in capabilities for every model at once and hands them to the editing draft. This step does not save anything.
- After a provider is saved or edited, after a configuration reload and a few seconds after startup, empty fields are filled in the background.
- Only empty fields are filled. Values you typed are left alone.
- A detection report on the settings page shows where each value came from and why a field stayed empty.

## Installation

Enter this in the DSH **Plugins** page:

```text
https://github.com/BunnySakura/dsh-model-capability-detector
```

To pin a version, append `#<tag>`, for example `#1.4.0`; the tag must already exist on GitHub. A local directory (absolute path) or a `.tgz` archive also works. Installation affects every session in the current profile.

Node.js 20.3.0 or later and a DSH version satisfying the package's declared requirements are needed. No build step runs and no install scripts execute.

## Settings

Open the Plugins page and enter this plugin's detail page. Every option is there, and a save applies immediately; only the startup delay waits for the next start. **Reset** returns a field to its default.

You can also give the plugin a `config` in your profile's `cordis.patch.yml`. Precedence, lowest to highest: built-in defaults, `config`, values saved on the settings page. Saved values live in `$DSH_HOME/model-capability-detector/settings.json` and contain only the options below, never secrets.

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When off, background detection and Models-page enrichment stop |
| `settingsNs` | `llm-pi-ai` | Settings namespace that holds provider profiles |
| `discoveryTrigger` | `true` | Fill the draft when you click Fetch available models |
| `overwrite` | `false` | Replace existing values with new results |
| `dryRun` | `false` | Compute without writing; pair with logging to see the plan |
| `timeoutMs` | `15000` | Timeout for one provider model-list request |
| `maxResponseBytes` | `4194304` | Provider response size limit; larger responses are cancelled |
| `debounceMs` | `800` | Coalesce rapid provider changes |
| `startupDelayMs` | `3000` | Delay before the startup fallback scan |
| `catalogFallback` | `true` | Allow public sources; when off, even built-in specifications are unused |
| `catalogNumbers` | `true` | Allow public sources to fill context and maximum output |
| `catalogNumericStrategy` | `official` | `official` is the tiered rule; `minimum` and `consensus` are legacy modes |
| `thirdPartySources` | `true` | Allow consulting OpenRouter and LiteLLM |
| `reasoningPreset` | `none` | Preset filled automatically when the sources agree a model reasons but name no level (`openai`, `extended`, `deepseek`, `toggle`); `none` fills nothing |
| `probeEnabled` | `false` | Offer **Probe channel** in the report; it sends a few billable requests to your provider and never runs by itself |
| `openrouterUrl` | `https://openrouter.ai/api/v1/models` | OpenRouter model list address. Point it at a mirror if the default is unreachable; http(s) without credentials only |
| `litellmUrl` | `model_prices_and_context_window.json` in the LiteLLM repository | LiteLLM model table address, same rules |
| `upgradeWritten` | `true` | Upgrade values the plugin wrote earlier when a stronger source appears |
| `modelAliases` | `{}` | Model-name aliases, format below |
| `catalogUrl` | `https://models.dev/api.json` | models.dev catalog address; http(s) without credentials only |
| `catalogTimeoutMs` | `30000` | Catalog request timeout |
| `catalogMaxBytes` | `16777216` | Catalog size limit |
| `catalogTtlMs` | `604800000` | Public-source cache lifetime, 7 days |
| `logging` | `false` | Send sanitized diagnostics to the DSH logger |
| `logFile` | `""` | Diagnostic log path, relative to DSH home; a non-empty path also enables logging. Saving it on the settings page requires a path inside DSH home |
| `updateCheckOnStartup` | `false` | Check for a new version about 10 seconds after startup |

An example in `cordis.patch.yml`:

```yaml
- id: dsh-model-capability-detector
  name: dsh-model-capability-detector
  config:
    timeoutMs: 20000
    modelAliases:
      my-gateway-gpt: gpt-4o
```

Invalid values in `config` are ignored and noted in the log; they never stop the plugin from loading.

## Where values come from

Each field takes the first available value from this list; higher entries win:

1. **Provider API:** unambiguous fields in the provider's model list, such as `context_length` or `max_output_tokens`.
2. **Original-provider documentation:** the built-in reviewed record, and models.dev entries that carry an original-provider documentation host.
3. **Third-party consensus:** a value is used when at least two of OpenRouter, LiteLLM and models.dev agree. Numbers within 5% of each other agree and the smaller one is used.
4. **API hints:** `max_input_tokens` and `max_tokens` mean different things across gateways, so they are used only when nothing above has a value.

Reasoning levels come only from the provider API and original-provider records. If the provider lists `deepseek-v4.1-flash` while the original provider only documents the dated `deepseek-v4.1-flash-1017`, and every dated snapshot of that vendor states the same levels, the levels are inferred and shown as "Same-line snapshots" in the report. Context window and maximum output are never inferred this way. An original specification describes the model itself and **does not guarantee a third-party provider exposes the same limits**.

When a model name does not match, add one line per alias under **Model name aliases** in the form `provider's name = standard model name`. Aliases match exactly and never chain.

The exact rules are in [Data sources and value rules](docs/data-sources.md).

## Detection report

The settings page's **Detection report** lists each provider and model with every field's value and source, and says why an empty field is empty:

| Reason | Meaning | What to do |
|---|---|---|
| No original-provider record | The model was not found | Add an alias, or type the value |
| Original record does not state it | The record has no such item | Type the value |
| Original records disagree | Different original records give different values | Type the value |
| No third-party data | Neither OpenRouter nor LiteLLM lists it | Add an alias, or type the value |
| Only one third-party source | Two are needed | Type the value |
| Third-party sources disagree | Clearly different numbers with equal support | Type the value |
| Public sources are off | `catalogFallback` is `false` | Turn that option on |

**Look up a model name** shows what a name resolves to and each third-party source's value without changing anything. **Detect again now** runs a pass immediately. None of the three contacts your provider or shows an address, key or header.

## FAQ

**Why does the settings page show a note instead of an Update button?** This copy runs from a development folder linked into the profile (`link:path`). Letting the plugin manager update it replaces the folder the link points to and can delete files in it. Pull the tag with git in that folder, or replace the `link:` entry with the GitHub address.

**Why are so many reasoning levels empty, with no reasoning control in the UI?** DSH treats a custom model without `reasoningEfforts` as non-reasoning. Levels can only come from the provider API and original-provider records; third-party sources carry none, and many original records only state a switch. For such a model the report shows whether the sources think it reasons, and offers two ways forward:
- Pick a preset and apply it by hand (low/medium/high, low/high/max, on/off only, and so on). A preset is a guess about what your provider accepts, so check it first.
- With **Allow probe requests** on, click **Probe channel** to ask your provider which levels it accepts, then decide whether to apply the result. It makes a few billable requests.

You can also pick **Preset for unknown levels** in the settings, so models the sources agree reason are filled automatically. It is off by default.

**Why did a value change although I never edited it?** When a stronger source appears, a value the plugin wrote earlier from a weaker one is upgraded. Values you typed or edited are never touched, with one exception: the starting reasoning levels `off/low/medium/high` that DSH's model page writes when you turn its reasoning switch on are replaced once the real levels are known. Turn off **Upgrade values this plugin wrote** to stop all of this.

**How do I make it overwrite existing values?** Turn on `overwrite`, or clear the field and save.

**How do I avoid all public sources?** Set `catalogFallback` to `false` to use the provider API only. To avoid just OpenRouter and LiteLLM, set `thirdPartySources` to `false`.

**Fetch available models does nothing or fails?** The plugin attaches by wrapping DSH's `llm.discoverModels` method, which a DSH update may break. Set `discoveryTrigger` to `false` to turn that off; background filling after saves and reloads is unaffected.

## Privacy and network use

- **Provider requests:** `GET {baseURL}/models` (`/v1/models` for Anthropic) to the provider you configured. API keys are read from DSH's credential service at call time, and redirects are rejected.
- **Channel probe:** off by default. With **Allow probe requests** on, and only when you click **Probe channel** for one model, about eight tiny chat requests go to that provider (`POST {baseURL}/chat/completions`, a fixed prompt, at most 256 output tokens each, billable). The result holds which levels were accepted, never an answer, address or key.
- **Public sources:** the models.dev catalog, `openrouter.ai/api/v1/models`, and LiteLLM's `model_prices_and_context_window.json` on GitHub. The OpenRouter and LiteLLM addresses can be replaced with mirrors. Requests carry no credentials or user data, and responses are size-limited.
- **Update checks:** off by default; when on, only this project's GitHub Releases are contacted.
- **Local files**, all under `$DSH_HOME`, with no keys, provider addresses or request headers:
  - `cache/model-capability-detector/` holds the public-source caches and provenance receipts. Receipts decide whether a value was written by the plugin; route and model names in them are hashed.
  - `model-capability-detector/settings.json` holds the values saved on the settings page.
- **Logging** is entirely off by default. When on, URL credentials, query strings and common credential patterns are redacted. Route and model names can still describe your deployment, so review logs before sharing them.

## Updates

**Check for updates** on the settings page reads the latest stable release of this project on GitHub. When a newer version exists, confirming hands the install to DSH's plugin manager, which decides on compatibility, script approval and whether a restart is needed. The read-only Agent tool `model_capability_detector_updates` can query but never install.

See the [changelog](CHANGELOG.md) for version history.

## Documentation

- [Design and architecture](docs/architecture.md) (Chinese)
- [Data sources and value rules](docs/data-sources.md) (Chinese)
- [Development and releases](docs/development.md) (Chinese)

## License

[MIT](LICENSE)
