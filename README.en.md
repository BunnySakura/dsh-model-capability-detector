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

## Source priority and conflicting limits

| Source | Policy |
|---|---|
| Existing configuration | Preserved unless overwrite is enabled |
| Current provider API | Takes precedence for every disclosed field |
| Catalog numeric fields | Minimum valid positive safe integer for one resolved identity |
| Catalog modalities | Disclosed entries must agree |
| Catalog reasoning levels | Intersection of disclosed level sets; explicit reasoning/non-reasoning conflicts are withheld |
| Unknown or ambiguous identity | Leave unchanged |

For example, `128000`, `131072` and `200000` resolve to **128000**, without rounding to K/M units. Token limits are integers already; rounding cannot resolve differences between providers. Fractions, non-positive values and unsafe integers are ignored.

The minimum is a conservative estimate, not a guarantee for an unpublished resale endpoint. It may trigger earlier context compaction. Prefer explicit endpoint limits or your own known settings. The plugin sends no inference requests to measure limits and consumes no chat tokens.

Strict alternatives:

```yaml
catalogNumericStrategy: consensus  # accept a numeric field only when values agree
# Or:
catalogNumbers: false             # disable numeric catalog fallback
```

`catalogFallback: false` disables the catalog entirely. Catalog lookup fills missing fields individually, and is skipped when the API discloses every eligible field. API failures may still allow catalog fallback; later settings changes can retry the API.

The catalog index is cached at `$DSH_HOME/cache/model-capability-detector/catalog.json` for 7 days by default. Cache reuse and stale fallback require matching source URL fingerprints and cache versions. Raw source URLs are not stored. A failed refresh may reuse a matching stale cache.

Names are matched by dropping the prefix before the final `/`, lowercasing and retaining alphanumerics. Version and date suffixes are not stripped. Names reaching multiple catalog identities are rejected rather than resolved arbitrarily.

## API metadata

The parser accepts `{data:[...]}`, `{models:{id:{...}}}`, `{models:[...]}` and top-level arrays. A model-map key is the request ID, even when its record names a different canonical ID.

- Context: `contextWindow`, `context_window`, `context_length`, `max_model_len`, `max_input_tokens`, `limit.context`, `top_provider.context_length`, and related spellings.
- Output cap: `max_output_tokens`, `max_tokens`, `max_completion_tokens`, `limit.output`, and related spellings.
- Image input: modality arrays, `architecture.modality`, and explicit vision flags.
- Reasoning: explicit effort lists such as `reasoning.supported_efforts`, `reasoning_efforts`, `thinking_levels`, and schema enums. Vendor aliases map to pi-ai levels; a boolean reasoning flag alone does not invent levels.

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
    catalogNumericStrategy: minimum
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

The implementation is Host-only. There are no installation scripts, runtime dependency downloads or changes to the DSH installation. See `index.js`, `lib/catalog.js`, `lib/detect.js`, `lib/discovery.js`, `lib/http.js` and `lib/diagnostics.js` for the implementation.
