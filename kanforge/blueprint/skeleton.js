// Skeleton generator (architecture.md §1, build_order.md §4.1).
// The LLM proposes a lemma decomposition of a theorem; every lemma is emitted as a
// kernel-typechecked `:= by sorry` stub (statement hash pinned per stub), the resulting
// DAG is audited (acyclicity + dependency coverage) by blueprint/dag.js, and the blueprint
// is emitted as blueprint.json + blueprint.md. Retries the whole decomposition (up to
// maxRetries) when the LLM output does not typecheck or fails the DAG audit.
import fs from 'node:fs';
import path from 'node:path';
import { hashStatement } from '../lean/pin.js';
import { stripImports } from '../agent/roles/autoformalizer.js';
import { resolveModule } from '../lean/moduleResolver.js';
import { validateBlueprint } from './dag.js';
import { STUB_TACTIC_MODULES } from '../search/tacticMenu.js';

export function buildSkeletonPrompt(theoremStatement) {
    return [
        {
            role: 'system',
            content: 'You are a Lean 4 formalization planner. Given a theorem, decompose it into a DAG of helper lemmas. Rules:\n' +
                '- Every lemma statement must be a valid standalone Lean statement of the form `lemma <name> : <proposition> := by sorry`.\n' +
                '- `deps` lists the NAMES of other helper lemmas this one needs; never list a lemma you did not define.\n' +
                '- `rootDeps` lists the helper-lemma names the theorem itself needs (omit for none).\n' +
                '- Return ONLY a JSON object, no prose, no markdown fences.\n' +
                'Format: {"lemmas":[{"name":"...","statement":"lemma ... := by sorry","deps":["..."]}],"rootDeps":["..."]}'
        },
        {
            role: 'user',
            content: `Decompose this theorem into kernel-typechecked helper lemma stubs:\n\n${theoremStatement}\n\nReturn the JSON decomposition.`
        }
    ];
}

export function parseDecomposition(text) {
    const t = String(text ?? '');
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : t;
    let parsed;
    try {
        parsed = JSON.parse(candidate);
    } catch {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start === -1 || end <= start) throw new Error('no JSON object found in LLM response');
        try {
            parsed = JSON.parse(candidate.slice(start, end + 1));
        } catch {
            throw new Error('LLM response is not parseable JSON');
        }
    }
    if (!parsed || !Array.isArray(parsed.lemmas)) throw new Error('decomposition JSON has no lemmas array');
    const lemmas = parsed.lemmas.map((l, i) => {
        if (!l || typeof l.name !== 'string' || typeof l.statement !== 'string') {
            throw new Error(`lemma[${i}] needs name and statement strings`);
        }
        return {
            name: l.name,
            statement: l.statement,
            deps: Array.isArray(l.deps) ? l.deps.filter(d => typeof d === 'string') : []
        };
    });
    return {
        lemmas,
        rootDeps: Array.isArray(parsed.rootDeps) ? parsed.rootDeps.filter(d => typeof d === 'string') : null
    };
}

export function normalizeStub(statement) {
    let s = String(statement).trim();
    // Strip ANY trailing body: `:= by sorry`, `:= by ...`, or a bare `:= ` (the LLM's re-split
    // sometimes emits an empty body). The stub is then normalized and re-stubbed uniformly.
    s = s.replace(/\s*:=\s*(?:by\s+.*?)?\s*$/s, '').trim();
    // Lean 4 has no `lemma` command (only `theorem`/`example`); normalize so the emitted
    // stub actually typechecks under the kernel. `m` flag: the lemma may follow prepended
    // import lines, so it is not at string position 0.
    s = s.replace(/^\s*lemma\s+/m, 'theorem ');
    return `${s} := by sorry`;
}

// Extract the `import ...` lines from a statement so stubs can be self-contained.
export function extractImports(statement) {
    const lines = String(statement ?? '').split(/\r?\n/);
    return lines.filter(l => /^\s*import\s+\S/.test(l)).join('\n');
}

export class SkeletonGenerator {
    constructor({ llm, backend, outDir = null, maxRetries = 2 } = {}) {
        if (!llm || !backend) {
            throw new Error('SkeletonGenerator requires a real llm client and a real backend');
        }
        this.llm = llm;
        this.backend = backend;
        this.outDir = outDir;
        this.maxRetries = maxRetries;
    }

    // Fast warm-env check of a stub (strip imports, use the warm session — ~0.4s after warm).
    // The fresh-env validation is the loop's extractGoals — the skeleton's job is speed, not
    // authority. A stub that typechecks only in warm env but not fresh (rare: name collisions
    // with mathlib) is caught by extractGoals and surfaced by the loop's error surfacing.
    async _tryCheck(statement) {
        const stripped = stripImports(statement);
        const fast = await this.backend.check(stripped, { useWarmEnv: true });
        if (fast.status === 'verified' || !/expected token/i.test(fast.error?.message ?? '')) return fast;
        return this.backend.check(statement);
    }

    async generate(theoremStatement) {
        const rootStatement = normalizeStub(theoremStatement);
        const rootCheck = await this._tryCheck(rootStatement);
        if (rootCheck.status !== 'verified') {
            return { ok: false, error: `theorem does not typecheck: ${rootCheck.error?.message ?? rootCheck.error ?? 'unknown error'}`, blueprint: null };
        }

        // Stubs from the LLM decomposition lack imports — they rely on the warm env for
        // symbols, but extractGoals (the loop's leased session) opens a fresh env (env: null).
        // Prepend the theorem's imports AND the standard tactic-library imports to every stub
        // so they are self-contained and the loop's tactic proposals actually resolve.
        const theoremImports = extractImports(theoremStatement).split('\n').map(l => l.replace(/^\s*import\s+/, '').trim()).filter(Boolean);
        const allImports = [...new Set([...theoremImports, ...STUB_TACTIC_MODULES.map(resolveModule).filter(Boolean)])];
        const imports = allImports.map(m => `import ${m}`).join('\n');

        let lastErrors = [];
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const outcome = await this._attempt(rootStatement, imports);
            if (outcome.ok) {
                if (this.outDir) this._write(outcome.blueprint);
                return outcome;
            }
            lastErrors = outcome.errors;
        }
        return { ok: false, error: `decomposition failed after ${this.maxRetries + 1} attempts`, errors: lastErrors, blueprint: null };
    }

    async _attempt(rootStatement, imports = []) {
        const warnings = [];
        let response;
        try {
            const t0 = Date.now();
            response = await this.llm.complete(buildSkeletonPrompt(rootStatement));
            const ms = Date.now() - t0;
            if (ms > 20000) console.log(`[skeleton] slow LLM call: ${(ms/1000).toFixed(1)}s`);
        } catch (err) {
            return { ok: false, errors: [`LLM call failed: ${err?.message ?? String(err)}`] };
        }
        let decomposition;
        try {
            decomposition = parseDecomposition(response?.text);
        } catch (err) {
            return { ok: false, errors: [err?.message ?? String(err)] };
        }

        const rootId = hashStatement(rootStatement);
        const byId = new Map([[rootId, { id: rootId, statement: rootStatement, name: 'theorem', deps: [] }]]);
        const nameToId = new Map();

        for (const cand of decomposition.lemmas) {
            // Prepend the theorem's imports so the stub is self-contained — extractGoals
            // opens a fresh env (env: null) and needs the imports to resolve symbols.
            const withImports = imports.length ? imports + '\n\n' + cand.statement : cand.statement;
            const stub = normalizeStub(withImports);
            const id = hashStatement(stub);
            if (id === rootId) {
                nameToId.set(cand.name, rootId); // LLM restated the theorem — alias it
                continue;
            }
            if (byId.has(id)) {
                nameToId.set(cand.name, id); // duplicate helper — alias, don't re-add
                continue;
            }
            const check = await this._tryCheck(stub);
            if (check.status !== 'verified') {
                warnings.push(`dropped lemma ${cand.name}: does not typecheck (${check.error?.message ?? check.error})`);
                continue;
            }
            byId.set(id, { id, statement: stub, name: cand.name, deps: [] });
            nameToId.set(cand.name, id);
        }

        // Resolve deps: name -> id. Unknown names are reported and drop out of the edge set.
        for (const [id, node] of byId) {
            if (node.name === 'theorem') continue;
            const src = decomposition.lemmas.find(c => c.name === node.name);
            const deps = [];
            for (const d of src?.deps ?? []) {
                const depId = nameToId.get(d);
                if (!depId) {
                    warnings.push(`lemma ${node.name}: unknown dependency "${d}" dropped`);
                } else if (depId !== id) {
                    deps.push(depId);
                }
            }
            node.deps = [...new Set(deps)];
        }

        // Root deps: the helpers the theorem needs (default: all helpers — safe, acyclic).
        let rootDeps;
        if (decomposition.rootDeps) {
            rootDeps = [];
            for (const d of decomposition.rootDeps) {
                const depId = nameToId.get(d);
                if (depId && depId !== rootId) rootDeps.push(depId);
            }
            rootDeps = [...new Set(rootDeps)];
        } else {
            rootDeps = [...byId.keys()].filter(id => id !== rootId);
        }
        byId.get(rootId).deps = rootDeps;

        const lemmas = [...byId.values()].map(n => ({ id: n.id, statement: n.statement, deps: n.deps, pinnedHash: n.id }));
        const blueprint = { theorem: rootStatement, lemmas };

        const audit = validateBlueprint(blueprint);
        if (!audit.ok) {
            return { ok: false, errors: audit.errors, warnings };
        }
        return { ok: true, blueprint, warnings };
    }

    _write(blueprint) {
        fs.mkdirSync(this.outDir, { recursive: true });
        fs.writeFileSync(path.join(this.outDir, 'blueprint.json'), JSON.stringify(blueprint, null, 2) + '\n');
        fs.writeFileSync(path.join(this.outDir, 'blueprint.md'), this._renderMarkdown(blueprint));
    }

    _renderMarkdown(blueprint) {
        const lines = ['# Blueprint', '', '## Theorem', '', '```lean', blueprint.theorem, '```', '', `## Lemmas (${blueprint.lemmas.length})`, ''];
        for (const l of blueprint.lemmas) {
            lines.push(`### ${l.id.slice(0, 10)}…`, '', '```lean', l.statement, '```', '', `- Deps: ${l.deps.map(d => `\`${d.slice(0, 10)}…\``).join(', ') || '(none)'}`, `- Pin: \`${l.pinnedHash}\``, '');
        }
        return lines.join('\n');
    }
}
