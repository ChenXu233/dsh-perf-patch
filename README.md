# dsh-perf-patch

Runtime-only performance patches for **DeepSeek Harness (DSH)** when third-party plugins make
the host O(N) slow. Nothing in `node_modules` is edited: the patches wrap host services at load
time, and each one **fails safe** — on any doubt it falls back to the original code path instead
of changing behaviour.

Built and measured on DSH Desktop `0.2.1-rc.2` (Electron 44 / Node 24 / Windows 11) with
`dsh-ops` and `dsh-mcp-connector` installed.

## What it fixes

### 1. The agent-mount `tools/change` storm

Mounting an agent registers ~161 tools. Every registration fires `tools/change`, and every
listener that reacts (discovery reconcile, PTC reconcile, MCP governance) replays its full
O(tools) work. One `agents.create` therefore emits hundreds of notifications, each listener
re-running hundreds of times.

**Fix:** while `agents.create` / `agents.resume` runs, `tools.layers.onChange` is suppressed and
the notification is emitted **once, synchronously**, when the outermost call returns.

Suppress + synchronous flush is deliberate. Flushing via `queueMicrotask` starves the event
loop (listeners queue more microtasks than the loop drains) and was observed to freeze the UI;
that variant was removed and is not shipped.

### 2. `tools.schemas()` deep-clones on every read

`schemas(scope)` clones every tool's JSON Schema; `schemaOf(def, true)` clones one. Both are pure
functions of the tool revision / definition, yet listeners call them in loops.

**Fix:** memoize `schemas(scope)` per tool revision (`WeakMap` keyed by scope, invalidated on
`tools/change`) and `schemaOf(definition, true)` by definition + parameter identity. Returned
objects are shared between callers, so treat them as **read-only**.

### 3. dsh-ops asks a one-boolean question with a full prompt assembly

`dsh-ops/lib/presentation.js` decides "is this agent on PTC presentation?" by calling
`systemPrompt.assemble({scope, signal})` and then reading exactly one thing:

```js
assembly.sections.some(s => s.name === 'tools:ptc-only' && s.text.trim() !== '')
```

`assemble()` renders ~36 sections and `structuredClone`s every tool schema (~250–310 ms
measured). dsh-ops does this **6× per live agent, per reconcile**.

**Fix:** wrap `systemPrompt.assemble`. When — and only when — the call is one of those probes,
return a minimal assembly built from the same layers:

```js
{ sections: [{ name: 'tools:ptc-only', text }], contexts: [], tools: [] }
```

Probe detection uses dsh-ops' own marker (`isPresentationProbe`, a `WeakSet` reached through the
module cache); if that import is unavailable it falls back to "the stack contains
`dsh-ops/lib/presentation.js`". Every other caller — including the real prompt assemblies in
`ptc/index.js` and `discovery/index.js` — passes straight through.

The section text is recomputed on **every** call. Caching it was tried and reverted: a stale
control input turns reconcile into a fixed point that never settles, and freezes the host.

Measured on a 3-agent instance: per probe **254–312 ms → 0 ms** (~4.9 s per reconcile sweep),
with the PTC decision byte-identical for all 3 agents.

## Install

```bash
cd ~/.dsh/profiles/desktop
npm install ChenXu233/dsh-perf-patch
```

Then list `"dsh-perf-patch"` in the `dsh.profile.bundles` array of the profile's
`package.json`. The package ships `dsh.bundle.patch` → `cordis.patch.yml`, which inserts the
loader entry. Adding the name to `bundles` **alone is not enough** — without the patch layer the
plugin is never loaded.

From a checkout: clone this repo into `<profile>/node_modules/dsh-perf-patch` and add the name to
`bundles` the same way.

## Kill switches

| Variable | Effect |
| --- | --- |
| `DSH_PERF_PATCH=0` | Disables all three patches at load time. |
| `DSH_PERF_PATCH_VERIFY=1` | Probe short-circuit also computes the full assembly and compares. On divergence it logs an error and **permanently disables** the short-circuit for the session. |

Runtime counters:

```js
globalThis.__dshPerfPatchProbe   // { hits, bypass, mismatches, enabled }
```

`hits` = probes answered short, `bypass` = calls that went to the real `assemble`. If `hits`
stays 0, detection is not matching and the plugin is a no-op.

## Expectations

* Intended to become **inert** once upstream fixes land: the schema cache is keyed by revision
  (correct regardless), and the probe short-circuit stands down when dsh-ops stops matching.
* The batch gate is the only behavioural change: listeners fire once per mount instead of once
  per tool. That is the point, but a plugin relying on every intermediate `tools/change` during
  mount would now see one.
* Do not mutate objects returned by `schemas()` / `schemaOf()`.

## Related upstream issues

* dsh-ops #333 — discovery reconcile recomputes presentation for every agent
* dsh-ops #369 — `tools.schemas()` deep copy with 258 tools, linear slowdown
* dsh-mcp-connector #178 — governance reconcile cost

If this plugin causes a problem: set `DSH_PERF_PATCH=0`, confirm it disappears, and open an issue
with the numbers.

## License

MIT
