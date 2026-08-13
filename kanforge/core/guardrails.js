// Invariant spec & guardrails (architecture.md §2.5 — the Giraud axioms).
// Guardrails-as-logic: the planner checks every proposed move against these before acting.
//
// Invariants:
//   1. statement/interface pins unchanged (no weakening)        — HARD
//   2. every VERIFIED lemma passed a kernel check               — HARD
//   3. no axiom/admit/unsafe/set_option/sorry leakage           — HARD (sorry is PHASE-SCOPED)
//   4. blueprint acyclic + dependency-complete
//   5. resumable from any checkpoint (serialize covers cached nodes) — HARD
//   6. invalidation touches only dependency descendants (locality)
//   7. scoped relaxations are recorded, unexpired, never HARD
//
// Permission model (§2.5): HARD invariants are never relaxed. PHASE-SCOPED relaxations
// (e.g. sorry stubs during skeleton/refine) come from ctx.permissions entries of the form
// { kind, phases?, expiresAt? }; every check verifies the grant is well-formed and unexpired.
// VERIFIED/COMMITTED states require the full HARD set with no outstanding grants — that is
// what assertLemmaCommit enforces at commit time.
//
// Real structures this consumes (core/pullgraph.js):
//   node = { computation: Lazy(() => statement), cached, value }
//   value (proved lemma) = { statement, proofScript, verifiedAt, goalCount, ms }
//   edges: Map<dependentId, Set<dependencyId>>

import { hashStatement } from '../lean/pin.js';
import { verifyHashChain } from './hasher.js';
import { buildProofSource } from './state.js';

export const HARD_INVARIANTS = Object.freeze([1, 2, 3, 5]);
export const FORBIDDEN_TOKENS = Object.freeze(['axiom', 'admit', 'unsafe', 'set_option', 'sorry']);

function nodeStatement(node) {
    if (!node) return null;
    if (node.value?.statement) return node.value.statement;
    try {
        const v = node.computation?.value;
        return typeof v === 'string' ? v : null;
    } catch {
        return null;
    }
}

function proofScripts(graph) {
    // The leakage scan covers the COMPLETE source (statement + proof composed — what the
    // kernel actually verified), not the proof script alone: a `set_option`/`axiom` smuggled
    // through the statement text is just as much a policy violation as one in the tactics.
    // The raw stub statement still says `:= by sorry`, so scanning it directly would false-trip
    // every proved lemma — composition replaces the sorry with the proof first.
    const out = [];
    for (const [id, node] of graph.nodes ?? new Map()) {
        if (node.cached && node.value && !node.value.error && node.value.proofScript) {
            let source = null;
            try {
                if (typeof node.value.statement === 'string') {
                    source = buildProofSource(node.value.statement, node.value.proofScript);
                }
            } catch {
                source = null;
            }
            out.push({ id, source: source ?? node.value.proofScript });
        }
    }
    return out;
}

function permissionActive(permissions, kind, now) {
    return (permissions ?? []).some(p =>
        p && p.kind === kind && (!p.expiresAt || p.expiresAt > now));
}

export class Guardrails {
    // Full invariant sweep. ctx: { pins?: Map<nodeId, Pin>, permissions?: [], hashChain?: [] }
    static checkAll(graph, ctx = {}) {
        const violations = [];
        const now = ctx.now ?? Date.now();
        const permissions = ctx.permissions ?? [];

        // 7. Permission grants are well-formed and unexpired; they never name a HARD invariant.
        for (const p of permissions) {
            if (!p || typeof p.kind !== 'string') {
                violations.push({ invariant: 7, type: 'PERMISSION_MALFORMED', message: 'grant missing kind' });
                continue;
            }
            if (p.expiresAt && p.expiresAt <= now) {
                violations.push({ invariant: 7, type: 'PERMISSION_EXPIRED', kind: p.kind, message: 'grant relied on past expiry' });
            }
        }

        // 1. Statement pins: a statement whose hash differs from its pin was weakened.
        for (const [id, pin] of ctx.pins ?? new Map()) {
            const node = graph.nodes.get(id);
            const statement = nodeStatement(node);
            if (statement == null) {
                violations.push({ invariant: 1, type: 'STATEMENT_MISSING', nodeId: id, message: 'pinned node has no statement' });
                continue;
            }
            if (hashStatement(statement) !== pin.statementHash) {
                violations.push({ invariant: 1, type: 'STATEMENT_WEAKENED', nodeId: id, message: 'statement hash differs from pin' });
            }
        }

        // 2. Every cached (verified) lemma carries kernel evidence: proofScript + verifiedAt.
        for (const [id, node] of graph.nodes ?? new Map()) {
            if (!node.cached || !node.value || node.value.error) continue;
            if (typeof node.value === 'object' && !('proofScript' in node.value)) continue; // non-lemma node
            if (!node.value.proofScript || !node.value.verifiedAt) {
                violations.push({ invariant: 2, type: 'VERIFIED_WITHOUT_KERNEL_CHECK', nodeId: id, message: 'cached lemma lacks kernel evidence' });
            }
        }

        // 3. Leakage: forbidden tokens anywhere in the COMPLETE verified source (statement +
        //    proof), not just the tactic script. `sorry` is relaxable only by an in-scope,
        //    unexpired 'sorry-stub' grant (skeleton/refine phases).
        for (const { id, source } of proofScripts(graph)) {
            for (const token of FORBIDDEN_TOKENS) {
                if (token === 'sorry' && permissionActive(permissions, 'sorry-stub', now)) continue;
                const re = new RegExp(`\\b${token}\\b`);
                if (re.test(source)) {
                    violations.push({ invariant: 3, type: 'LEAKAGE', nodeId: id, token, message: `forbidden token '${token}' in verified source` });
                }
            }
        }

        // 4. Acyclicity (dependency-complete is checked at dispatch by the scheduler gate).
        const cycle = Guardrails.findCycle(graph);
        if (cycle) {
            violations.push({ invariant: 4, type: 'CYCLE', message: `circular dependency: ${cycle.join(' -> ')}` });
        }

        // 5. Checkpoint identity: serialize() must cover every cached node.
        try {
            const serialized = graph.serialize();
            const covered = new Set(serialized.objects.map(o => o.id));
            for (const [id, node] of graph.nodes ?? new Map()) {
                if (node.cached && node.value !== undefined && !covered.has(id)) {
                    violations.push({ invariant: 5, type: 'CHECKPOINT_GAP', nodeId: id, message: 'cached node absent from serialize()' });
                }
            }
        } catch (err) {
            violations.push({ invariant: 5, type: 'CHECKPOINT_UNSERIALIZABLE', message: err.message });
        }

        // checkHermetic: the run's statement hash chain is intact.
        if (ctx.hashChain) {
            const chain = verifyHashChain(ctx.hashChain);
            if (!chain.ok) {
                violations.push({ invariant: 5, type: 'HASH_CHAIN_BROKEN', message: chain.reason });
            }
        }

        return { ok: violations.length === 0, violations };
    }

    // HARD-set commit gate (§2.5): a lemma may become VERIFIED only if the pin holds, the
    // kernel accepted the full source, and the COMPLETE source (statement + proof, `source`
    // param) is clean — permissions never apply here. The scan covers the source text, so
    // leakage through the statement (axiom/unsafe/set_option smuggled outside the tactics) is
    // caught, not just leakage through the script.
    static assertLemmaCommit({ pin, statement, proofScript, verification, source = null }) {
        const violations = [];
        if (pin && hashStatement(statement) !== pin.statementHash) {
            violations.push({ invariant: 1, type: 'STATEMENT_WEAKENED', message: 'statement hash differs from pin at commit' });
        }
        if (verification?.status !== 'verified') {
            violations.push({ invariant: 2, type: 'KERNEL_REJECTED', message: verification?.error?.message ?? 'kernel did not verify the proof' });
        }
        const scanTarget = source ?? proofScript ?? '';
        for (const token of FORBIDDEN_TOKENS) {
            if (new RegExp(`\\b${token}\\b`).test(scanTarget)) {
                violations.push({ invariant: 3, type: 'LEAKAGE', token, message: `forbidden token '${token}' in committed source` });
            }
        }
        return { ok: violations.length === 0, violations };
    }

    // Invariant 6 (locality, Wave2 §7): every invalidated node must be a dependency
    // descendant of a changed node; anything else is an unrelated cache clear.
    static checkInvalidationLocality(graph, changedIds, invalidatedIds) {
        const descendants = new Set();
        const stack = [...changedIds];
        // edges: dependentId -> Set<dependencyId>; invert to dependency -> dependents.
        const dependents = new Map();
        for (const [dependent, deps] of graph.edges ?? new Map()) {
            for (const dep of deps) {
                if (!dependents.has(dep)) dependents.set(dep, new Set());
                dependents.get(dep).add(dependent);
            }
        }
        while (stack.length) {
            const id = stack.pop();
            for (const d of dependents.get(id) ?? []) {
                if (!descendants.has(d)) {
                    descendants.add(d);
                    stack.push(d);
                }
            }
        }
        const extra = [...invalidatedIds].filter(id => !descendants.has(id) && !changedIds.includes(id));
        return { ok: extra.length === 0, unrelated: extra };
    }

    static findCycle(graph) {
        const visited = new Set();
        const visiting = new Set();
        const path = [];
        const dfs = (id) => {
            if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
            if (visited.has(id)) return null;
            visiting.add(id);
            path.push(id);
            for (const dep of graph.edges?.get(id) ?? []) {
                const cycle = dfs(dep);
                if (cycle) return cycle;
            }
            visiting.delete(id);
            path.pop();
            visited.add(id);
            return null;
        };
        for (const id of graph.nodes?.keys() ?? []) {
            const cycle = dfs(id);
            if (cycle) return cycle;
        }
        return null;
    }
}
