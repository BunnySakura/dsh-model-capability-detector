# dsh-model-capability-detector

Detects and fills in a model's capabilities when you import a provider, instead of
leaving you to type each field by hand.

> 中文文档（主要版本）：[README.md](README.md)

## What this solves

The DSH Models page does request a provider's model list, but it only adopts
`id`, `name`, `contextWindow`, `maxTokens`, and input modalities — and only when
you press "fetch models". Metadata that does not use exactly those field names is
dropped, and reasoning levels are never fetched at all.

This plugin reads the same listing and writes back the capabilities it
**explicitly discloses**:

| Field | Meaning |
|---|---|
| `contextWindow` | how much context the model accepts |
| `maxTokens` | the output cap it advertises |
| `input` | `["text"]` or `["text", "image"]` |
| `reasoningEfforts` | the thinking levels it offers; `false` when it has none |

## When it runs

- After a provider profile is saved or edited on the Models page
  (`settings/document-updated`).
- After the profile's patches are reconciled (`app-boot/config-reload`).
- Once a few seconds after startup, covering a profile whose endpoint was
  unreachable or whose plugin was disabled at the time.

Bursts of configuration writes are coalesced into one probe, and only one probe
runs at a time.

## How a capability is read

Listings disagree on field names, nesting, and even on whether a capability is a
boolean, a list, or a string. Detection covers the common spellings:

- **Context** — `contextWindow`, `context_window`, `context_length`,
  `max_context_length`, `max_model_len`, `max_input_tokens`, `limit.context`,
  `top_provider.context_length`.
- **Output cap** — `maxOutputTokens`, `max_output_tokens`, `max_tokens`,
  `max_completion_tokens`, `limit.output`, `top_provider.max_completion_tokens`.
- **Image input** — `architecture.input_modalities`, `input_modalities`,
  `modalities.input`, `input`, `architecture.modality` (such as
  `text+image->text`), plus the `capabilities.vision`, `supports_vision`, and
  `vision` flags.
- **Reasoning levels** — `reasoning.supported_efforts`, `reasoning.efforts`,
  `reasoning_efforts`, `thinking_levels`, `supported_thinking_levels`,
  `parameters.reasoning_effort.enum`, with vendor spellings mapped onto pi-ai's
  vocabulary (`none` → `off`, `mid` → `medium`, `extra high` → `xhigh`,
  `ultra` → `max`).

Both envelope shapes are read: OpenAI's `{ "data": [...] }` array and the
`{ "models": { "<id>": {…} } }` map some gateways use.

**A capability the endpoint does not disclose is never written.** Guessing costs
more than silence here: an inflated `contextWindow` silently truncates
conversations, and a wrong `input` list blocks images the model does support.

## Scope and write policy

Only routes **your own profile layer declares** are inspected and rewritten. A
route an installed bundle declares is left alone, so the bundle's future updates
are not shadowed by a frozen copy.

Existing values win by default: only blank fields are filled. Set
`overwrite: true` to replace values the listing discloses.

The write goes through the settings service, so it lands in the profile's own
`cordis.patch.yml` and takes effect through the normal Loader path — no restart.

## Public-catalog fallback

Many resale gateways answer `/models` with nothing but `{"id":"...","object":"model"}`,
disclosing no capability at all. In that case the plugin consults the public
[models.dev](https://models.dev) catalog (~5.8 MB, cached at
`$DSH_HOME/cache/model-capability-detector/catalog.json` for 7 days).

**The fallback is per-field, not wholesale**, because one model name means
different things to different providers — resale channels routinely serve a
truncated context window. Measured agreement across catalog entries that share a
name:

| Field | Agreement | Default |
|---|---|---|
| Image input | 87.1% | enabled |
| Reasoning levels | 79.4% | enabled |
| Context window | 52.1% | **off**, needs `catalogNumbers: true` |
| Output cap | 47.3% | **off**, needs `catalogNumbers: true` |

An inflated context window silently truncates conversations, which is the worst
failure mode here; a wrong modality list or reasoning level surfaces immediately
as an attachment that will not send or a request the API rejects.

Even for an enabled field, a value is written only when **every catalog entry
carrying that name agrees**. On disagreement the candidates are recorded in the
log and the configured value is left alone.

### Name normalization

Third-party naming differences are handled in two steps: drop the provider
segment before the last `/`, then lowercase and keep only alphanumerics. So
`GPT-6.1-SOL`, `gpt_6_1_sol`, `Gpt-6.1-Sol`, and `openai/gpt-6.1-sol` all reach
one identity.

Two cases refuse rather than guess:

- **No match**: `gpt-9-ultra`, or a dated `gpt-6.1-sol-2026-01-01`, resolves to
  `unknown` and is left for you to type.
- **Ambiguous identity**: when one name can reach two distinct catalog identities
  (a dated and an undated entry, say), the answer is `ambiguous` — never the
  first one found.

## Diagnostics log

DSH's logger keeps a 1000-entry in-memory ring and this deployment registers no
sink that writes to disk, so a failed pass leaves **no record anywhere** —
"decided not to write" and "never ran" look identical. That is the root cause of
hard-to-diagnose behaviour.

Set `logFile` to enable an optional JSONL diagnostics log:

```yaml
    logFile: "~/.dsh/logs/model-capability-detector.log"
```

It records each probed route, how many fields it disclosed, catalog hits and
conflicts, and the write plan and result. **No credential is recorded**: URLs are
stripped of their query string, and neither keys nor response bodies ever reach
it. A file over 2 MiB is rotated once, keeping one generation.

Empty (the default) disables it and produces no disk writes at all.

## The HMR transaction constraint

`settings.update` reaches `configEditor.edit`, which wraps its work in
`hmr.runExclusive` and refuses a nested transaction with
`HMR transactions cannot be nested`. The Loader activates a plugin inside that
same exclusive scope, and `app-boot/config-reload` is published from inside it, so
a probe started from either inherits the transaction marker through every timer
and promise it creates.

The write therefore runs under `AsyncLocalStorage.exit`, the one documented way to
leave that scope. A fresh `AsyncResource` does not work: it captures the store
current at construction, which is already the transaction when `apply` runs.

This is verified end to end, not only in unit tests: after installing, a temporary
route pointing at a public listing was added to the profile, and its
`contextWindow`, `maxTokens`, `input`, and `reasoningEfforts` were all filled in
automatically. That route was then removed and the profile restored.

## Configuration

Edit the row in your profile's `cordis.patch.yml`:

```yaml
- id: dsh-model-capability-detector
  name: "dsh-model-capability-detector"
  config:
    settingsNs: llm-pi-ai     # profile entry id of the adapter whose providers to fill
    enabled: true             # false turns automatic detection off entirely
    overwrite: false          # true replaces values you already set
    dryRun: false             # true only logs the plan, without writing
    timeoutMs: 15000          # per-endpoint listing timeout, in milliseconds
    debounceMs: 800           # quiet period after a settings change
    startupDelayMs: 3000      # delay before the startup pass
    maxResponseBytes: 4194304
    catalogFallback: true     # false never queries the public catalog
    catalogUrl: "https://models.dev/api.json"
    catalogTimeoutMs: 30000   # catalog download timeout
    catalogMaxBytes: 16777216 # catalog size ceiling
    catalogTtlMs: 604800000   # cache lifetime, 7 days by default
    catalogNumbers: false     # true also trusts context window and output cap
    logFile: ""               # diagnostics log path; empty disables it
```

When onboarding a new gateway, start with `dryRun: true`: the planned changes are
logged and the profile is left untouched.

## Credentials

The listing request uses the route's own `apiKeyEnv` reference, resolved through
the credentials service at call time — the same reference the adapter uses, so a
key rotated on the Models page takes effect without a restart. A route with no
`apiKeyEnv` is probed without an auth header, which is correct for a local vLLM or
Ollama endpoint.

Custom `headers` configured on the route are sent as well, so a gateway that needs
an extra header still answers.

## Failure behaviour

An unreachable endpoint, a rejected key, or an unreadable listing logs one warning
naming the route and the reason, and changes nothing. It never blocks the import:
the profile is already saved by the time this plugin runs.

If two writes race, the stale revision is refused and the resulting document event
schedules another probe against the fresh value.

## Layout

```
index.js                    Host plugin: listener, endpoint probe, fallback, write-back
lib/detect.js               Pure listing readers: capabilities, levels, URL, headers
lib/plan.js                 Pure merge with per-field catalog gating
lib/catalog.js              Pure catalog: index, name matching, agreement, cache
lib/diagnostics.js          Optional JSONL log with redaction and rotation
test/detect.test.mjs        Listing parsing and merge unit tests
test/catalog.test.mjs       Catalog fallback and name-matching unit tests
test/diagnostics.test.mjs   Redaction, concurrency, and rotation tests
test/fallback.test.mjs      Fallback integration through the real pass
test/plugin.test.mjs        Behaviour tests for apply(), including the HMR scope case
test/live-probe.mjs         Read-only probe against a public listing
cordis.patch.yml            The bundle row this package inserts
```

## Running the tests

```bash
node --test test/detect.test.mjs test/catalog.test.mjs test/diagnostics.test.mjs test/fallback.test.mjs test/plugin.test.mjs
```

## Installing

Install the local directory into the current profile:

```
plugin_manager install_bundle target=<absolute path to this directory>
```

Or with the DSH CLI:

```bash
dsh plugin --profile <profile> add ./dsh-model-capability-detector
```

Once published to npm, it can be installed from the registry directly.

## Known limits

- Only routes declared by the profile's own layer are handled; bundle-declared
  routes are left to their declaring bundle.
- Fields an endpoint does not disclose are left as they are, never inferred.
- The catalog fallback is gated per field: numeric fields are off unless
  `catalogNumbers: true` is set explicitly.
- A name that cannot be matched, or that maps to an ambiguous identity, is never
  written; type it by hand.
- Host-side only, with no separate UI; results appear in the profile configuration
  and in the diagnostics log.
