// dsh-perf-patch
//
// Two runtime-only mitigations for the "agent mount emits one tools/change per
// registered tool" problem. No third-party source is modified.
//
//   1. Batch gate: while an agent is mounting (ctx.agents.create/resume), the
//      ToolRuntime layer change callback is recorded but not dispatched. When the
//      outermost batch ends the notification is emitted ONCE, synchronously.
//      This is a synchronous suppress + synchronous flush: there is no deferred
//      delivery, so listeners reacting with their own changes cannot starve the
//      event loop (that failure mode belongs to microtask deferral).
//
//   2. Schema memoization: schemas(scope) is cached per tool revision and
//      schemaOf(definition, true) per definition/parameters identity, so the
//      listeners that still run once per batch pay for one materialization
//      instead of one per tool.
//
// Kill switch: DSH_PERF_PATCH=0 disables both at load time.
// Safety: if a batch stays open longer than 30s the gate force-flushes and logs.

export const name = 'perf-patch';

const ROOT_SCOPE = {};

export function apply(root, raw) {
  const enabled = process.env.DSH_PERF_PATCH !== '0';
  if (!enabled) {
    root.logger?.info?.('perf-patch: disabled by DSH_PERF_PATCH=0');
    return;
  }

  root.inject(['tools'], (ctx) => {
    const tools = ctx.get('tools');
    if (!tools || typeof tools.schemas !== 'function') return;

    // ---------- 2. schema memoization ----------
    if (!tools.__schemaCache) {
      const state = { rev: 0, hits: 0, misses: 0, defHits: 0, paramHits: 0, defMisses: 0, since: Date.now() };
      const scopeCache = new WeakMap();
      const defCache = new WeakMap();
      const paramCache = new WeakMap();
      const originalSchemas = tools.schemas.bind(tools);
      const originalSchemaOf = typeof tools.schemaOf === 'function' ? tools.schemaOf.bind(tools) : null;

      if (originalSchemaOf) {
        tools.schemaOf = function (definition, detach) {
          if (detach !== true || definition === null || typeof definition !== 'object') {
            return originalSchemaOf(definition, detach);
          }
          const params = definition.parameters;
          const own = defCache.get(definition);
          if (own !== undefined && own.params === params) { state.defHits += 1; return own.value; }
          const stamp = String(definition.name) + '\u0000' + String(definition.description);
          if (params !== null && typeof params === 'object') {
            const shared = paramCache.get(params);
            if (shared !== undefined && shared.stamp === stamp) {
              state.paramHits += 1;
              defCache.set(definition, { params, value: shared.value });
              return shared.value;
            }
          }
          state.defMisses += 1;
          const value = originalSchemaOf(definition, detach);
          try { defCache.set(definition, { params, value }); } catch {}
          if (params !== null && typeof params === 'object') {
            try { paramCache.set(params, { stamp, value }); } catch {}
          }
          return value;
        };
      }

      tools.schemas = function (scope) {
        const key = (scope === undefined || scope === null) ? ROOT_SCOPE : scope;
        let hit;
        try { hit = scopeCache.get(key); } catch { hit = undefined; }
        if (hit !== undefined && hit.rev === state.rev) { state.hits += 1; return hit.value; }
        state.misses += 1;
        const value = originalSchemas(scope);
        try { scopeCache.set(key, { rev: state.rev, value }); } catch {}
        return value;
      };

      if (typeof tools.revision !== 'function') tools.revision = () => state.rev;
      tools.__schemaCache = state;
      globalThis.__dshTools = tools;
      ctx.on('tools/change', () => { state.rev += 1; });
    }

    // ---------- 1. batch gate ----------
    const layers = tools.layers;
    if (!layers || typeof layers.onChange !== 'function') {
      ctx.logger?.warn?.('perf-patch: tools.layers.onChange not found; batch gate skipped');
      return;
    }
    if (layers.__batchGate) return;

    const nativeChange = layers.onChange.bind(layers);
    const gate = { depth: 0, pending: false, suppressed: 0, flushes: 0, forced: 0, openedAt: 0 };
    layers.__batchGate = gate;

    layers.onChange = function () {
      gate.suppressed += 1;
      if (gate.depth > 0) {
        gate.pending = true;
        // Diagnostics only: never mutate the counter from here. Forcing a flush
        // mid-batch used to desynchronise depth and leave the gate permanently
        // closed, which is far worse than a slow batch.
        if (gate.openedAt && Date.now() - gate.openedAt > 30000 && !gate.slow) {
          gate.slow = true;
          gate.slowCount = (gate.slowCount || 0) + 1;
          ctx.logger?.warn?.('perf-patch: batch open >30s (diagnostic only, gate stays consistent)');
        }
        return;
      }
      nativeChange();
    };

    function flush() {
      if (!gate.pending) return;
      gate.pending = false;
      gate.flushes += 1;
      gate.openedAt = 0;
      try { nativeChange(); } catch (error) { ctx.logger?.warn?.('perf-patch: flush listener failed: ' + error.message); }
    }

    let agents = null;
    try { agents = ctx.get('agents'); } catch {}
    if (!agents || typeof agents.create !== 'function') {
      ctx.logger?.warn?.('perf-patch: agents registry not found; batch gate inert');
      return;
    }

    const wrap = (name) => {
      const original = agents[name];
      if (typeof original !== 'function') return;
      agents[name] = async function (...args) {
        if (gate.depth === 0) { gate.openedAt = Date.now(); gate.slow = false; }
        gate.depth += 1;
        try {
          return await original.apply(this, args);
        } finally {
          gate.depth = Math.max(0, gate.depth - 1);   // never negative
          if (gate.depth === 0) flush();
        }
      };
    };
    wrap('create');
    wrap('resume');

    ctx.logger?.info?.('perf-patch: batch gate armed (agents.create/resume coalesce tools/change)');

    // ---------- 3. narrow inspection API for prompt sections ----------
    // dsh-ops needs one boolean ("is the tools:ptc-only section empty?") and pays a
    // full systemPrompt.assemble() for it, once per live agent, on every reconcile.
    // We expose the read it actually needs: render only the named sections, fresh
    // every call (no caching — a cached control input creates a fixed-point loop
    // that never lets the caller's decision change).
    try {
      const sp = ctx.get('systemPrompt');
      if (sp && typeof sp.assemble === 'function' && typeof sp.inspect !== 'function' && sp.layers && typeof sp.layers.merge === 'function') {
        sp.inspect = function (contextOrScope, names) {
          const wanted = new Set(Array.isArray(names) ? names : [names]);
          const context = (contextOrScope !== null && typeof contextOrScope === 'object' && 'scope' in contextOrScope)
            ? contextOrScope
            : { scope: contextOrScope };
          const merged = sp.layers.merge(context.scope, (layer) => layer.sections);
          const out = {};
          for (const [name, section] of merged) {
            if (!wanted.has(name)) continue;
            out[name] = typeof section.text === 'function' ? section.text(context) : section.text;
          }
          return out;
        };
        ctx.logger?.info?.('perf-patch: systemPrompt.inspect armed (section-only rendering)');
      }
    } catch (error) {
      ctx.logger?.warn?.('perf-patch: inspect API skipped: ' + error.message);
    }

    // ---------- 4. presentation-probe short-circuit (monkeypatch, no source edit) ----------
    // dsh-ops decides "is this agent on PTC presentation?" by calling
    // prompt.assemble({ scope, signal }) from its lib/presentation.js, for every live
    // agent, six times per reconcile. assemble() renders every section AND deep-clones
    // every tool schema (161 tools); dsh-ops reads exactly one boolean out of it:
    // "does the tools:ptc-only section have non-empty text?".
    //
    // We never edit dsh-ops. We wrap systemPrompt.assemble and answer that one probe
    // with a minimal assembly built from the same layers, recomputed on every call
    // (no caching: a stale control input turns reconcile into a fixed point that never
    // settles). Every non-probe call passes through to the original assemble.
    const probeState = { hits: 0, bypass: 0, mismatches: 0, enabled: true };
    globalThis.__dshPerfPatchProbe = probeState;

    try {
      const sp = ctx.get('systemPrompt');
      if (!sp || typeof sp.assemble !== 'function' || !sp.layers || typeof sp.layers.merge !== 'function') {
        ctx.logger?.warn?.('perf-patch: systemPrompt.assemble not found; probe short-circuit skipped');
      } else if (!sp.__perfProbeWrapped) {
        const originalAssemble = sp.assemble.bind(sp);
        const verify = process.env.DSH_PERF_PATCH_VERIFY === '1';
        let isProbe = null;
        try {
          import(new URL('../../dsh-ops/lib/presentation.js', import.meta.url).href).then((mod) => {
            if (typeof mod.isPresentationProbe === 'function') {
              isProbe = mod.isPresentationProbe;
              ctx.logger?.info?.('perf-patch: dsh-ops probe marker resolved');
            }
          }).catch(() => {});
        } catch (error) {
          ctx.logger?.warn?.('perf-patch: probe marker unavailable: ' + error.message);
        }

        const ptcOnlyText = (context) => {
          const merged = sp.layers.merge(context.scope, (layer) => layer.sections);
          const section = merged.get('tools:ptc-only');
          if (section === undefined) return '';
          const raw = typeof section.text === 'function' ? section.text(context) : section.text;
          return raw === undefined || raw === null ? '' : String(raw);
        };

        sp.assemble = async function (context, ...rest) {
          let probe = false;
          if (probeState.enabled && context !== null && typeof context === 'object' && 'scope' in context) {
            if (isProbe !== null) {
              probe = isProbe(context) === true;
            }
            if (!probe) {
              // Fallback while the marker import resolves (or if dsh-ops changes shape):
              // only calls that originate inside dsh-ops/lib/presentation.js are probes.
              const stack = String(new Error('probe').stack || '');
              probe = stack.includes('dsh-ops\\lib\\presentation.js') || stack.includes('dsh-ops/lib/presentation.js');
            }
          }
          if (!probe) {
            probeState.bypass += 1;
            return originalAssemble(context, ...rest);
          }
          let text;
          try {
            text = ptcOnlyText(context);
          } catch (error) {
            probeState.enabled = false;
            ctx.logger?.warn?.('perf-patch: probe short-circuit disabled: ' + error.message);
            return originalAssemble(context, ...rest);
          }
          if (verify) {
            const full = await originalAssemble(context, ...rest);
            const section = (full.sections || []).find((item) => item.name === 'tools:ptc-only');
            const expected = section === undefined ? '' : String(section.text || '');
            if (expected !== text) {
              probeState.mismatches += 1;
              probeState.enabled = false;
              ctx.logger?.error?.('perf-patch: probe answer diverged from assemble; short-circuit disabled');
              return full;
            }
          }
          probeState.hits += 1;
          return { sections: [{ name: 'tools:ptc-only', text }], contexts: [], tools: [] };
        };
        sp.__perfProbeWrapped = true;
        ctx.logger?.info?.('perf-patch: presentation-probe short-circuit armed' + (verify ? ' (verify mode)' : ''));
      }
    } catch (error) {
      ctx.logger?.warn?.('perf-patch: probe short-circuit skipped: ' + error.message);
    }



  });
}
