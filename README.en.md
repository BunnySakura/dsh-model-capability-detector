# dsh-model-capability-detector

Detects and fills in a model's capabilities when you import a provider, instead of
leaving you to type each field by hand.

> 涓枃鏂囨。锛堜富瑕佺増鏈級锛歔README.md](README.md)

## What this solves

The DSH Models page does request a provider's model list, but it only adopts
`id`, `name`, `contextWindow`, `maxTokens`, and input modalities 鈥?and only when
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

- **Context** 鈥?`contextWindow`, `context_window`, `context_length`,
  `max_context_length`, `max_model_len`, `max_input_tokens`, `limit.context`,
  `top_provider.context_length`.
- **Output cap** 鈥?`maxOutputTokens`, `max_output_tokens`, `max_tokens`,
  `max_completion_tokens`, `limit.output`, `top_provider.max_completion_tokens`.
- **Image input** 鈥?`architecture.input_modalities`, `input_modalities`,
  `modalities.input`, `input`, `architecture.modality` (such as
  `text+image->text`), plus the `capabilities.vision`, `supports_vision`, and
  `vision` flags.
- **Reasoning levels** 鈥?`reasoning.supported_efforts`, `reasoning.efforts`,
  `reasoning_efforts`, `thinking_levels`, `supported_thinking_levels`,
  `parameters.reasoning_effort.enum`, with vendor spellings mapped onto pi-ai's
  vocabulary (`none` 鈫?`off`, `mid` 鈫?`medium`, `extra high` 鈫?`xhigh`,
  `ultra` 鈫?`max`).

Both envelope shapes are read: OpenAI's `{ "data": [...] }` array and the
`{ "models": { "<id>": {鈥 } }` map some gateways use.

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
`cordis.patch.yml` and takes effect through the normal Loader path 鈥?no restart.

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
- id: model-capability-detector
  name: "dsh-model-capability-detector"
  config:
    settingsNs: llm-pi-ai   # profile entry id of the adapter whose providers to fill
    enabled: true           # false turns automatic detection off entirely
    overwrite: false        # true replaces values you already set
    dryRun: false           # true only logs the plan, without writing
    timeoutMs: 15000        # per-endpoint listing timeout, in milliseconds
    debounceMs: 800         # quiet period after a settings change
    startupDelayMs: 3000    # delay before the startup pass
    maxResponseBytes: 4194304
```

When onboarding a new gateway, start with `dryRun: true`: the planned changes are
logged and the profile is left untouched.

## Credentials

The listing request uses the route's own `apiKeyEnv` reference, resolved through
the credentials service at call time 鈥?the same reference the adapter uses, so a
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
index.js              Host plugin: settings listener, endpoint probe, write-back
lib/detect.js         Pure listing readers: capabilities, levels, URL, headers
lib/plan.js           Pure merge: discovered capabilities into configured models
test/detect.test.mjs  Unit tests for both pure modules
test/plugin.test.mjs  Behaviour tests for apply(), including the HMR scope case
test/live-probe.mjs   Read-only probe against a public listing
cordis.patch.yml      The bundle row this package inserts
```

## Running the tests

```bash
node --test test/detect.test.mjs test/plugin.test.mjs
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

## Known limits

- Only routes declared by the profile's own layer are handled; bundle-declared
  routes are left to their declaring bundle.
- Fields an endpoint does not disclose are left as they are, never inferred.
- Host-side only, with no separate UI; results appear in the profile configuration
  and in the log.
