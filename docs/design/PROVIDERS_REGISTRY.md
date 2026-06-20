# Multi-Provider BYOK Registry

## Problem Statement

Before this work, ncode had no BYOK path at all — operators with their own
OpenAI-compatible API keys (DeepSeek, OpenRouter, Fireworks, Together,
self-hosted vLLM) could not use them. The interactive TUI was hardwired to
the Noumena-managed (1P) catalog.

This design adds BYOK support as a file-backed registry co-located with
existing settings, plus a model-tagged picker that resolves provider from
the model entry at request time.

Key principles:

- **Picker is the integration point**. Each registry entry contributes labelled
  entries to `/model`. Selecting an entry is the trigger for provider switching.
- **No new config format**. The registry lives in `.ncode/settings.json` (JSON,
  already loaded), not a toml/yaml file.
- **Per-model resolution, not process-global**. The 30+ `getAPIProvider()` call
  sites stay env-var driven. The resolver for the picker-selected model is
  separate (`getActiveProviderEndpointForModel(modelId)`).
- **No auth-context reload**. Switching to a managed (1P) entry from a BYOK
  entry mid-session requires the Noumena OAuth session to already exist. If
  it doesn't, picking the 1P entry fails loudly (clear error, no silent
  fallback). Full runtime auth-context reload is **out of scope** (see
  Non-Goals).

## Module Layout

```
src/utils/model/
  providers.ts          — add: UserProvider, UserProviderModel,
                          loadUserProviders(),
                          findRegistryEntryForModel(modelId),
                          getActiveProviderEndpointForModel(modelId)
                          (existing getAPIProvider() unchanged)
  providers.test.ts     — extended with tests for env-var fallback path
  providersRegistry.test.ts (new) — registry resolver tests
  modelOptions.ts       — add: optional provider?: string on ModelOption,
                          getUserProviderModelOptions() helper,
                          getModelOptionsBase wraps the original body
                          (renamed to getModelOptionsBaseExcludingRegistry)
                          to append registry entries when present
  settings/
    types.ts             — add: UserProviderSchema, UserProviderModelSchema,
                          types UserProvider and UserProviderModel,
                          providers?: UserProvider[] field on SettingsSchema
services/api/
  inferenceClient.ts    — getInferenceClient reads args.model and consults
                          getActiveProviderEndpointForModel(model) first;
                          falls back to env-var custom-provider path when
                          no registry entry matches
docs/design/
  PROVIDERS_REGISTRY.md — this design doc
```

## Schema

### `SettingsJson` (extension)

Add an optional `providers` array to `.ncode/settings.json`. Each entry
declares one OpenAI-compatible BYOK endpoint and the curated model list it
serves:

```json
{
  "providers": [
    {
      "name": "deepseek",
      "base_url": "https://api.deepseek.com",
      "api_key_env": "DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-v4-pro",
          "label": "DeepSeek V4 Pro",
          "description": "Reasoning model for complex, multi-step edits",
          "supports_thinking": true
        },
        {
          "id": "deepseek-v4-flash",
          "label": "DeepSeek V4 Flash",
          "description": "Fast model for quick edits and sub-agents"
        }
      ]
    },
    {
      "name": "openrouter",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key_env": "OPENROUTER_API_KEY",
      "models": [
        {
          "id": "anthropic/claude-3.5-sonnet",
          "label": "Claude 3.5 Sonnet (OpenRouter)"
        },
        {
          "id": "google/gemini-2.0-flash",
          "label": "Gemini 2.0 Flash (OpenRouter)"
        }
      ]
    }
  ]
}
```

**Notes:**

- `api_key_env` is the *name* of the env var to read, not the key itself. The
  key is never serialized to settings. This matches the existing model in
  `~/.config/noumena/ncode/api_key` (where keys live out-of-band of settings).
- `base_url` is the API origin only. ncode appends `/v1/chat/completions` and
  `/v1/models`. No trailing `/v1` segment.
- `supports_thinking` is an optional hint. When true, the picker tags the entry
  with the thinking indicator. Default false. This does NOT replace a real
  capability probe — it just gives the picker something to render before the
  first request.

### New types in `providers.ts`

```typescript
export type UserProviderModel = {
  id: string
  label: string
  description?: string
  supports_thinking?: boolean
}

export type UserProvider = {
  name: string
  base_url: string
  api_key_env: string
  models: UserProviderModel[]
}

/**
 * Load the operator's BYOK providers from .ncode/settings.json.
 * Readonly. Returns [] when the file is absent, the providers key is missing,
 * or validation fails. Schema validation (UserProviderSchema) guarantees
 * shape — no defensive reload needed.
 */
export function loadUserProviders(): readonly UserProvider[]

/**
 * Find the registry entry that declares the given model ID. First match
 * wins — operators should use distinct model IDs to disambiguate across
 * providers offering the same upstream model.
 */
export function findRegistryEntryForModel(modelId: string): UserProvider | undefined

/**
 * Return the { baseURL, apiKey } pair for the given model ID. Resolution
 * order:
 *   1. Registry lookup (does any declared entry expose this model ID?)
 *      → return that entry's base_url + api_key (read lazily from env var)
 *   2. undefined (caller treats as firstParty/Anthropic-native path)
 *
 * Throws if the registry entry's api_key_env points at an unset env var —
 * loud failure preferred over silent unauthorized requests.
 *
 * The API key is read lazily on each call, so key rotations take effect
 * without restarting ncode.
 */
export function getActiveProviderEndpointForModel(
  modelId: string | undefined,
): { baseURL: string; apiKey: string } | undefined
```

**Note: the original spec called for a separate `setActiveProviderForSession()` +
`getActiveProviderForModel()` pair.** Those turned out to be dead indirection:
since model IDs are themselves the lookup key into the registry and IDs must
be unique per provider, a "session-active" map keyed by model ID returned
results identical to direct registry lookup. Removed during implementation
review (every line must earn its keep). If future requirements need the
operator to switch to a model *not* declared in the registry (and resolve
provider for it), that's when the session-active override earns its keep.

## Picker Integration

`getModelOptionsBase()` in `modelOptions.ts` adds a new top branch:

```typescript
function getModelOptionsBase(fastMode = false): ModelOption[] {
  const session = getCurrentSubscriptionSessionState()

  // User-declared BYOK providers: surface their models in the picker.
  // Each entry is tagged with its owning provider so onSelect can resolve
  // the runtime provider from the selected model rather than from env.
  const userProviders = loadUserProviders()
  if (userProviders.length > 0) {
    const registryOptions: ModelOption[] = []
    for (const provider of userProviders) {
      for (const model of provider.models) {
        registryOptions.push({
          value: model.id,
          label: model.label,
          description: model.description ?? `${provider.name} (${model.id})`,
          _provider: provider.name,
        })
      }
    }
    return dedupeModelOptions([
      getDefaultOptionForUser(fastMode),
      ...getNCodeManagedModelOptions(),  // managed entries stay visible
      ...registryOptions,
    ])
  }

  if (isInternalBuild()) { ... }
  // ... existing branches unchanged
}
```

**Managed entries do not disappear when registry is set.** This is the
behavioral fix for "no coexistence with managed models": the picker now shows
`Default + managed + user BYOK`. Selecting a managed entry resolves to
`'firstParty'` via `getActiveProviderForModel()`, selecting a registry entry
resolves to `'custom'` with the per-entry baseURL/apiKey.

## Inference Client Threading

`getInferenceClient({ ... })` (in `inferenceClient.ts`) currently takes
`{ maxRetries, source, fetchOverride }`. Extend with an optional override:

```typescript
export async function getInferenceClient(
  args: {
    maxRetries?: number
    source?: string
    fetchOverride?: typeof fetch
    model?: string  // NEW: when provided, resolve provider from registry
  },
): Promise<InferenceClient>
```

When `args.model` is set and `getActiveProviderForModel(model)` returns
`'custom'`, the client uses the registry-provided `base_url` and the API key
read from `api_key_env`, rather than the env-var-derived
`NCODE_CUSTOM_PROVIDER_URL` / `NCODE_CUSTOM_PROVIDER_API_KEY`.

When `args.model` is set and the resolver returns `'firstParty'`, the existing
firstParty branch runs unchanged.

When `args.model` is not set, behavior is identical to today (env-var
resolution). This keeps existing call sites that don't pass `model` working —
no migration needed.

## Test Plan

Tests added to `src/utils/model/providers.test.ts`, following the existing
`describe('custom provider', ...)` block pattern:

1. `loadUserProviders()` returns [] when settings file is absent
2. `loadUserProviders()` returns [] when `providers` key is missing
3. `loadUserProviders()` returns the parsed array when `providers` is valid
4. `loadUserProviders()` skips entries with missing `base_url`
5. `loadUserProviders()` skips entries with missing `api_key_env`
6. `loadUserProviders()` skips entries with empty `models` array (logs warning)
7. `getActiveProviderForModel('deepseek-v4-pro')` returns 'custom' when registry
   declares it
8. `getActiveProviderForModel('kimi-2.7-coder')` returns 'firstParty' when model
   is not in any registry entry
9. `getActiveProviderForModel('unknown-model')` falls back to env resolution
10. `setActiveProviderForSession('deepseek-v4-pro')` persists and is consulted
    by `getActiveProviderForModel` on subsequent calls
11. After registry load, `getModelOptions()` includes all registry entries
    alongside the managed catalog
12. After registry load, managed entries are still present (no shadowing)

## Non-Goals

- **Auth-context reload**. Switching from a BYOK entry to a managed entry
  mid-session with no active OAuth does NOT auto-trigger login. The picker
  surfaces a clear error if the user attempts this. Full auth-context reload
  (Shape B) is out of scope — it touches 30+ `getAPIProvider()` call sites in
  auth/runtime/migrations/telemetry and is a separate larger PR.
- **Live `/v1/models` discovery**. The registry is hand-curated. The picker
  does not query the provider's `/v1/models` endpoint to populate entries.
  This is intentional: avoids a startup network call, avoids surfacing every
  variant the provider offers (most users want a curated shortlist).
- **Per-provider model catalog unification**. Each registry entry is its own
  model namespace. Two providers can declare models with the same `id` —
  they will both appear in the picker and resolve to their own `base_url`.
  Display name collisions are the operator's problem to disambiguate via
  `label`.
- **Settings UI for managing the registry from inside the TUI**. Editing the
  registry is a file-edit operation. No `/provider add` command. Adding one
  is a follow-up UX PR.
- **Encrypted/managed key storage beyond env vars**. `api_key_env` reads from
  `process.env`. There is no operator keyring integration. If the env var
  is unset at the time of the request, the client throws with a clear error
  naming the missing variable.

## Open Questions

1. **Should `_provider: string` be added to the public `ModelOption` type, or
   carried in a side registry indexed by `value`?** RESOLVED: added to type as
   optional `provider?: string` field. Default undefined for managed entries.
   Informational only — the resolver keys off the model ID, not this field,
   so it carries display/disambiguation value rather than runtime authority.

2. **Should the registry support non-OpenAI-compatible providers (Bedrock,
   Vertex)?** Current design is BYOK-OpenAI-compat only. Bedrock/Vertex already
   have env-var paths (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`).
   Adding them to the registry is feasible but would require different auth
   schemes. Defer.

3. **Should the active model selection survive across ncode restarts?**
   Today the design is per-process: the settings file declares available
   providers, but the active model within a session is lost on restart.
   Persisting this to a small state file (`~/.local/state/ncode/active-model`)
   is a separate small PR. Not in this scope.

4. **Reasoning-level translation gap under DeepSeek.** `thinkingEnabled`
   under `custom` sends Anthropic-shaped `thinking.budget_tokens` through
   `OpenAICompatInferenceClient`. DeepSeek's API uses `reasoning_effort`
   for the request and `reasoning_content` for streamed deltas. Whether the
   inference client translates correctly has NOT been verified — this is
   tracked separately from the registry, but operators enabling
   supports_thinking: true on a DeepSeek entry should expect to verify
   thinking actually flows before relying on it.