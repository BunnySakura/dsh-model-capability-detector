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

Default priority: **existing configuration → current channel API → directly verified original specifications → original-provider records mirrored by models.dev**. Reseller capacities are no longer aggregated into a default minimum.

`catalogNumericStrategy: official` is the new default and applies to all catalog fields. A directly reviewed DeepSeek-V4.1-Flash-1017 record supplies **1048576** context tokens, **393216** output tokens, image input and disclosed reasoning efforts. Sources: the official [release](https://api-docs.deepseek.com/news/news261017/), its [pinned model config](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/config.json) and [API reference](https://api-docs.deepseek.com/api/create-chat-completion/), reviewed 2026-10-31. This exact snapshot remains usable offline. Floating aliases such as `deepseek-flash` resolve through the original-provider catalog record rather than being permanently pinned to an old release.

Other models use original-provider entries from models.dev with an explicit provider identity and an allowlisted official documentation host; entries with a foreign canonical vendor are excluded. **models.dev is a community mirror; the plugin does not re-verify every website field on each pass.** Receipts distinguish `official-verified` from `original-provider-mirror`. The current host rules cover DeepSeek, OpenAI, Anthropic, Google, xAI, Mistral, Cohere, Moonshot and Zhipu. Unrecognized publishers remain unknown.

Matching preserves punctuation, dates and versions, folding only case and surrounding whitespace. A channel prefix may differ when the complete model name matches. Conflicting identities or field values are withheld. API disclosures win field by field. No inference requests are sent to measure limits.

Original specifications **do not guarantee a reseller exposes the same limits**; receipts retain `channelVerified: false`. Existing values remain unchanged by default. Old minimum estimates cannot be distinguished from manual values and are not raised automatically. Clear a field and save after reviewing the replacement when you want to adopt it.

```yaml
catalogNumericStrategy: official   # default: original specifications
# catalogNumericStrategy: minimum   # explicit legacy reseller minimum
# catalogNumericStrategy: consensus # explicit legacy numeric consensus
catalogNumbers: true               # false disables numeric fallback
catalogFallback: true              # false disables all public fallback, including built-in specifications
```

The v5 catalog cache lives at `$DSH_HOME/cache/model-capability-detector/catalog.json`, with a default 7-day lifetime. A matching source and format may serve stale data after a failed refresh. Future timestamps are not fresh. The source URL is hashed instead of persisting its query parameters.

After a successful configuration write, `provenance.json` in that directory retains field values, source URLs, time and a SHA-256 route/model/field key. It stores no provider endpoint, key or request headers. Public original model identities may appear in source metadata; keep these local files private.

## API metadata

The parser accepts `{data:[...]}`, `{models:{id:{...}}}`, `{models:[...]}` and top-level arrays. A model-map key is the request ID, even when its record names a different canonical ID.

- Context: `contextWindow`, `context_window`, `context_length`, `max_model_len`, `max_input_tokens`, `limit.context`, `top_provider.context_length`, and related spellings.
- Output cap: `max_output_tokens`, `max_tokens`, `max_completion_tokens`, `limit.output`, and related spellings.
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

## Plugin updates

Open the **Plugin updates** tab on DSH's Plugins page. Opening it reads local status only. **Check for updates** queries GitHub Releases for the fixed `BunnySakura/dsh-model-capability-detector` repository and shows the stable version, plain-text notes and a fixed-tag installation target. Drafts, prereleases and invalid tags are rejected. A 404 means no published stable release; rate limits and network failures do not interrupt detection.

**Review update** opens confirmation, then hands the selected target to **DSH's native installation dialog**. DSH owns progress, compatibility checks, script approval, failures and restart requirements. This plugin never uninstalls itself, invokes pnpm or authorizes scripts. If DSH refuses replacement as already installed, preserve your overrides and use its uninstall/reinstall flow. A failed install after removal leaves the package uninstalled; atomic rollback is not guaranteed.

`updateCheckOnStartup: false` disables background release requests by default. Enabling it checks once after startup. Results are cached for 24 hours within one process; restarting clears that cache. Manual checks refresh it. The read-only `model_capability_detector_updates` tool exposes `status` and `check`, with no installation action. No channel URLs, model lists, keys or configuration enter these requests.

Maintainers must publish a matching stable GitHub Release and version tag; pushing branch commits alone produces no update notice. Catalog refreshes and code updates are separate. The package version is 1.3.0.

The UI targets DSH 0.2.1-rc.5's plugin-page extension contracts. Existing explicit configuration overrides, including `minimum`, remain effective. The UI becomes available only after this code is installed; offline tests do not establish that the running profile has been updated.
