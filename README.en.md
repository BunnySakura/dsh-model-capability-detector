# dsh-model-capability-detector

Collect model context size, output limits, image support and reasoning levels when fetching or saving a third-party API provider in DSH. Explicit API metadata takes precedence; missing fields can fall back to [models.dev](https://models.dev).

> 中文文档：[README.md](README.md)

## Triggers and persistence

- **Fetch available models:** interrogates custom endpoints immediately, fills missing candidate metadata from the public catalog and returns context, output limits and input modalities to the editor draft. Fetching alone does not save configuration.
- **Save or edit a provider:** `settings/document-updated` schedules a pass that fills missing fields, including reasoning levels.
- **Reload and startup:** `app-boot/config-reload` and a delayed startup pass cover existing configurations.

Existing values are preserved unless `overwrite: true`. Only routes declared in the user's own profile layer are rewritten. Writes use `settings.update` with revision checks and the normal Loader/HMR flow.

DSH currently exposes no model-discovery completion event, and a namespace cannot register a second discovery handler. The plugin therefore installs a reversible wrapper around the public `llm.discoverModels` method, scoped to `settingsNs` and custom routes with an explicit `baseURL`. Built-in catalog providers keep their original discovery. It does not access private discovery registries or alter HTTP/RPC transport. Set `discoveryTrigger: false` to disable this bridge. Changes to DSH's discovery method or draft interface require compatibility verification.

Core discovery candidates do not carry reasoning levels. The plugin retains only parsed capability metadata in an in-memory cache: at most 8 entries for 5 minutes. Endpoint, protocol, credential and custom-header SHA-256 fingerprints isolate entries without retaining raw credentials or response bodies. Saving a matching draft reuses that metadata; expired or changed targets are probed again. Unsaved drafts are never persisted by the background pass.

## Source priority and original specifications

Each field takes the first available value from this list; **higher entries win**, and existing values are kept by default:

1. **The channel API's unambiguous fields**, such as `context_length`, `max_output_tokens`, `top_provider.max_completion_tokens`.
2. **Original-provider specifications**: the built-in reviewed record and models.dev entries that carry an original-provider documentation host.
3. **Third-party consensus**: OpenRouter, LiteLLM and models.dev. A value is used when **at least two agree**. Numbers within 5% of each other agree and the smaller one is used, so a difference like 65536 versus 65535 does not block the field. An outlier inside one source is outvoted by its majority, and two agreeing sources outvote a third. With only one source, or two equally sized groups that are far apart, the field stays empty and the detection report says why. Third parties supply context, output cap and image input only; reasoning levels come from original records.
4. **API hints**: `max_input_tokens` and `max_tokens` mean different things across gateways (an input-only limit, a default output size), so they are used only when nothing above has a value.

A reviewed DeepSeek-V4.1-Flash-1017 record is built in: **1048576** context tokens, **393216** output tokens, image input and disclosed reasoning efforts. Sources: the official [release](https://api-docs.deepseek.com/news/news261017/), its [pinned model config](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/config.json) and [API reference](https://api-docs.deepseek.com/api/create-chat-completion/), reviewed 2026-10-31. It works when public sources are unavailable and matches the exact snapshot ID only.

models.dev entries need an explicit provider identity and an allowlisted official documentation host; entries with a foreign canonical vendor are excluded. **models.dev is a community mirror; the plugin does not re-verify every website field on each pass.** The host rules cover DeepSeek, OpenAI, Anthropic, Google, xAI, Mistral, Cohere, Moonshot and Zhipu.

**Name matching** tries, in order: the full name; the name without a channel prefix; then a relaxed *family match* that ignores a `:free`-style variant suffix, an 8-digit date snapshot and separator differences (`3.5` versus `3-5`). Family matches are marked `≈` in the report, and are withheld when they reach several identities or the original records disagree. Short numeric suffixes such as `-1017` are part of a model's identity and are never stripped. When a channel names models unusually, add `channel name = standard name` under **Model name aliases**; each entry matches exactly and aliases never chain.

**Upgrades**: a value the plugin wrote earlier from a weaker source (its receipt still equals the current value) is replaced when a stronger source appears. A value you typed or edited has no matching receipt and is never touched. Turn this off with **Upgrade values this plugin wrote**. Values from older versions have no receipt and are treated as yours.

Original specifications **do not guarantee a reseller exposes the same limits**; receipts keep `channelVerified: false`. No inference requests are sent to measure limits.

```yaml
catalogNumericStrategy: official   # default: original -> third-party tiers (above)
# catalogNumericStrategy: minimum   # explicit legacy reseller minimum; no third-party tiers
# catalogNumericStrategy: consensus # explicit legacy numeric consensus
thirdPartySources: true            # false never contacts OpenRouter / LiteLLM
upgradeWritten: true               # false keeps values the plugin wrote earlier
modelAliases: { my-gateway-gpt: gpt-4o }
catalogNumbers: true               # false disables numeric fallback
catalogFallback: true              # false disables all public fallback, including built-in specifications
```

The **detection report** (settings page) lists each saved route and model with every field's value and its tier (channel API, original provider, third-party consensus, API hint, set by you), and says why an empty field is empty. **Look up a model name** shows what a name would resolve to and each third-party source's vote, without changing anything. **Detect again now** runs a pass immediately. None of these contacts your channel or shows an address, key or header.

Public sources: the models.dev catalog (configurable URL), `https://openrouter.ai/api/v1/models`, and LiteLLM's `model_prices_and_context_window.json` from GitHub raw. The last two URLs are fixed, requests carry no credentials or user data, and responses are size-limited. Caches live in `$DSH_HOME/cache/model-capability-detector/`: `catalog.json` (v5) and `thirdparty.json`, valid for 7 days by default; a failed refresh may reuse a stale cache from the same source.

After a successful configuration write, `provenance.json` in that directory retains field values, source, time and a SHA-256 route/model/field key. It stores no provider endpoint, key or request headers. Public original model identities may appear in source metadata; keep these local files private.
## API metadata

The parser accepts `{data:[...]}`, `{models:{id:{...}}}`, `{models:[...]}` and top-level arrays. A model-map key is the request ID, even when its record names a different canonical ID.

- Context: `contextWindow`, `context_window`, `context_length`, `max_model_len`, `limit.context`, `top_provider.context_length`, and related spellings.
- Output cap: `max_output_tokens`, `max_completion_tokens`, `limit.output`, and related spellings.
- Hints only: `max_input_tokens` and `max_tokens` are ambiguous (see above).
- Image input: modality arrays, `architecture.modality`, and explicit vision flags.
- Reasoning: explicit effort lists such as `reasoning.supported_efforts`, `reasoning_efforts`, `thinking_levels`, and schema enums. Vendor aliases map to pi-ai levels. An API effort list containing only `off` / `none` becomes `reasoningEfforts: false`, preventing reasoning fallback. A boolean reasoning flag alone does not invent levels. Modality strings such as `text->image` are parsed on the input side of the arrow only.

OpenAI-compatible protocols use `GET {baseURL}/models`. Anthropic uses `GET /v1/models?limit=1000` and accepts roots with or without `/v1`. Custom headers go only to the provider endpoint. Credentials resolve at call time; an explicitly configured reference that cannot resolve never silently becomes an anonymous probe. Saved credentials and headers are reused only when the draft endpoint and protocol match the stored route. A changed endpoint needs its own credential, and a typed key takes precedence over saved authentication headers. Provider redirects are rejected to prevent forwarding custom authentication headers. Response limits are enforced by actual bytes during streaming.

## Logging and privacy

**All plugin logging is off by default:** `logging: false` and `logFile: ""` suppress both Host and diagnostic-file output. Public catalog caching may still write to disk independently.

Enable diagnostics explicitly:

```yaml
logging: true                                # DSH Host logger only
logFile: "logs/model-capability-detector.log"  # JSONL file plus Host logging
```

An empty path disables the file; also set `logging: false` to return to full silence. Relative paths and `~/` resolve against DSH home. For example, use `~/logs/detector.log` without adding another `.dsh` segment.

Logs contain decisions and capability fields, not raw credentials, headers or response bodies. URL userinfo, query strings, fragments and common credential patterns are redacted. Errors are not passed through as raw objects. A file above 2 MiB retains one `.1` generation. Route names and model IDs can still describe your deployment, so review diagnostic files before sharing. Environment files, local caches and logs are ignored by Git by default.

## Configuration

Override the plugin row in your profile patch:

```yaml
- id: dsh-model-capability-detector
  name: dsh-model-capability-detector
  config:
    settingsNs: llm-pi-ai
    enabled: true
    overwrite: false
    dryRun: false
    timeoutMs: 15000
    debounceMs: 800
    startupDelayMs: 3000
    maxResponseBytes: 4194304
    catalogFallback: true
    catalogUrl: https://models.dev/api.json
    catalogTimeoutMs: 30000
    catalogMaxBytes: 16777216
    catalogTtlMs: 604800000
    catalogNumbers: true
    catalogNumericStrategy: official
    thirdPartySources: true
    upgradeWritten: true
    modelAliases: {}
    updateCheckOnStartup: false
    discoveryTrigger: true
    logging: false
    logFile: ""
```

`dryRun: true` computes the write plan without persisting it; enable `logging` or `logFile` to view it. Draft discovery candidates can still be returned.

When upgrading from 1.1, explicit profile overrides such as `catalogNumbers: false` or a nonempty `logFile` remain effective. Change your override to adopt the new numeric policy. Previously populated numeric values remain untouched unless overwrite is enabled.

## Stability and validation

Background passes are serialized and settings bursts are coalesced. Configuration is reread before writing, so a slow request cannot replace arrays built from a newer user edit. Unloading cancels pending requests, timers and capability caches and prevents late writes. The existing HMR transaction-scope escape is retained for settings updates.

```sh
node --test test/*.test.mjs
```

Tests use synthetic fixtures and fake fetch, without real provider credentials. They cover parsing, numeric conflicts, cache-source isolation, redaction, fetch-then-save, unload cancellation, concurrent edits and HMR. Offline tests do not establish browser acceptance; verify actual Models-page behavior against the target DSH version.

## Installation

This repository supports installation directly from GitHub; downloading or generating a `.tgz` archive first is unnecessary. In the DSH **Plugins** page, enter:

```text
https://github.com/BunnySakura/dsh-model-capability-detector
```

The pnpm GitHub shorthand also works:

```text
github:BunnySakura/dsh-model-capability-detector
```

An Agent uses `plugin_manager` with `install_bundle` and either address as `target`. By default, this installs the repository's default branch. To pin a revision, append `#<tag or full commit SHA>`; that tag or commit must already exist on GitHub. Installation requires connectivity to GitHub and a DSH version satisfying the package's declared requirements.

The repository root already includes the bundle declaration, patch, JavaScript entry point, runtime modules, locales and icon. No compilation or installation scripts are required. Local directories (using an absolute path) and `.tgz` packages can still be installed through the plugin manager. Installation affects all sessions in the current profile; perform it when ready to activate this version.

## Plugin settings and updates

Open DSH's Plugins page and enter this plugin's own detail page (`dsh-model-capability-detector`). Settings and online updates sit together in its configuration area. Nothing is added to the global tabs, and no other plugin is affected.

- **Every option is editable in the GUI**: the enable switch, model-settings namespace, Models-page enrichment, request timeout and response limit, startup delay, the public catalog switch/URL/timeout/cache, numeric source policy, overwrite and dry-run, and logging.
- **Saving applies immediately**: **Save settings** applies the change and re-checks saved providers without reloading the plugin. Only the startup delay waits for the next start.
- **Three layers**: built-in defaults < this plugin's `config` in `cordis.patch.yml` < values saved from the GUI. GUI values are written to `$DSH_HOME/model-capability-detector/settings.json`, containing only these options and no secrets. A field marked **Set here** can be **Reset** to the layer below.
- **Validation**: numbers have ranges, the namespace must be lowercase letters, digits and hyphens, the catalog URL must be http(s) without credentials, and the log file must stay inside DSH home. Invalid values in `cordis.patch.yml` are ignored and noted in the Host log; they never stop the plugin from loading.
- **Concurrency**: a save carries a revision. If the file changed elsewhere, the save is refused and the page loads the latest values with a notice. Writes need a custom request header and a JSON content type, and pass DSH's sign-in and origin checks.

**Check for updates at startup** is off by default; when on, one check runs about 10 seconds after startup. **Check for updates** works at any time, and results are cached for 24 hours in the current process. When a newer version exists, confirming makes the page call the DSH plugin manager's `installBundle` for that stable tag of the fixed repository `BunnySakura/dsh-model-capability-detector`. The Host composes the target and the page checks it again. Compatibility, install-script approval and the final result belong to the plugin manager: if it reports a restart is required, restart DSH; if it needs script approval, handle that on the Plugins page and retry. The read-only Agent tool `model_capability_detector_updates` can only query, never install.
