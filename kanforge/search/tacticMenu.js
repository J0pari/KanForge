// Tactic-menu augmentation (build_order.md §5.2): closes the proposal-distribution coverage
// gap observed in the §5.1 run — the model NEVER proposed `tauto` for tauto_elim, so every
// recipe failed even though Mathlib.Tactic.Tauto is imported and `tauto` decides it. That is a
// recall/coverage hole, not a search failure, and RL cannot reinforce a tactic it never samples.
//
// Architecture: an import-verified capability layer at the llm.complete seam, mirroring
// PremiseAugmentingLLM. The menu is (1) grounded in the statement's imports (we author the
// import lines, so the tactic universe is known and non-circular — it never consults the
// problem's `family`), (2) keyed on the goal's shape (head connective + logical structure),
// and (3) hypercompressed: closers first, then decomposers, each with a one-line
// "composes as" hint so the model sees how tactics combine rather than a bare name list.
// Judge prompts (swiss) are never augmented; the wrapper chain is menu-innermost so it layers
// under the premise augmenter (which rebuilds the prompt wholesale).

import { parseProposalGoal, promptText } from './premises.js';

// Core Lean tactics available in ANY repl session (Mathlib or not). The base env is core Lean +
// Std: the core smoke set (bench/smoke.js) uses omega, rcases, rintro, induction, constructor,
// native_decide against the real repl, so they are core cards — NOT module-provided. `when` is
// only a hint; a card shows when its shape tag is present.
const CORE_CARD_META = {
    intro: { when: 'goal is → or ∀', compose: 'then work in the body' },
    exact: { when: 'goal matches a hypothesis or lemma', compose: 'closes outright' },
    rw: { when: 'equality goal with a matching lemma', compose: 'then simp or rfl' },
    apply: { when: 'goal applies a lemma/constructor', compose: 'closes or makes progress' },
    cases: { when: 'a hypothesis is ∨/∧/inductive', compose: 'splits it; solve each case' },
    rcases: { when: 'a hypothesis is ∧/∨/∃/inductive', compose: 'split it into named cases (e.g. rcases h with ⟨a, ha⟩ | hb)' },
    rintro: { when: 'goal is →/∀ and hypotheses need splitting', compose: 'intro + case-split in one' },
    induction: { when: 'a variable admits induction', compose: 'then solve base + step' },
    by_contra: { when: 'negation goal or by contradiction', compose: 'then derive False' },
    contradiction: { when: 'hypotheses clash', compose: 'closes outright' },
    assumption: { when: 'goal equals a hypothesis', compose: 'closes outright' },
    constructor: { when: '∧ goal (or ∨ via left/right)', compose: 'then solve each part' },
    left: { when: '∨ goal', compose: 'prove the left disjunct' },
    right: { when: '∨ goal', compose: 'prove the right disjunct' },
    rfl: { when: 'definitionally-equal goal', compose: 'closes outright' },
    simp: { when: 'goal simplifies by definitions', compose: 'then rfl; use simp [<lemma>]' },
    decide: { when: 'closed decidable proposition', compose: 'closes by computation' },
    native_decide: { when: 'closed decidable proposition', compose: 'closes by compiled computation' },
    omega: { when: 'linear arithmetic (Nat/Int/Real)', compose: 'closes outright' }
};

// Module-provided tactics, curated against the imports our statements actually use. Only the
// module's headline tactics are listed; transitive availability is claimed only where
// empirically verified against v4.33.0-rc1 (Mathlib.Data.Nat.Basic provides omega — verified
// by repl probe). Data modules that provide no headline tactic of their own are empty.
export const MODULE_TACTICS = {
    'Mathlib.Tactic.Ring': ['ring', 'ring_nf'],
    'Mathlib.Tactic.Linarith': ['linarith', 'nlinarith'],
    'Mathlib.Tactic.NormNum': ['norm_num'],
    'Mathlib.Tactic.Positivity': ['positivity'],
    'Mathlib.Tactic.FieldSimp': ['field_simp'],
    'Mathlib.Tactic.Tauto': ['tauto'],
    'Mathlib.Data.Nat.Basic': ['omega'],
    'Mathlib.Data.Nat.Prime.Basic': [],
    'Mathlib.Data.Real.Basic': []
};

// Canonical tactic-library imports every stub needs (architecture.md §0.3 capability baseline).
// These are the non-core, module-provided tactics that the loop's LLM reaches for — ring,
// norm_num, linarith, positivity, tauto, field_simp, abel. Core tactics (omega, rw, simp,
// intro, exact, apply, constructor, etc.) are available in ANY repl session without import.
// The set is derived from MODULE_TACTICS' non-empty-module keys + abel (missing from
// MODULE_TACTICS in v4.33.0-rc1 — add it here since the loop's LLM proposes `abel`).
// Domain-agnostic: the arithmetic/algebraic closers work across number theory, combinatorics,
// geometry, and analysis. Domain-specific theorem libraries (SimpleGraph, MeasureTheory, etc.)
// are NOT included — those come from the corpus entry's own import profile.
export const STUB_TACTIC_MODULES = [
    'Mathlib.Tactic.Ring',
    'Mathlib.Tactic.Linarith',
    'Mathlib.Tactic.NormNum',
    'Mathlib.Tactic.Positivity',
    'Mathlib.Tactic.FieldSimp',
    'Mathlib.Tactic.Tauto',
    'Mathlib.Tactic.Abel'
];

const MODULE_CARD_META = {
    tauto: { when: 'propositional tautology (∧ ∨ → ¬, no arithmetic)', compose: 'closes outright, no intro needed' },
    ring: { when: 'polynomial identity over a ring', compose: 'closes outright' },
    ring_nf: { when: 'polynomial identity over a ring', compose: 'normalizes then closes' },
    omega: { when: 'linear arithmetic (Nat/Int/Real)', compose: 'closes outright' },
    linarith: { when: 'linear arithmetic with ≤/< hypotheses', compose: 'closes outright' },
    nlinarith: { when: 'nonlinear arithmetic', compose: 'closes outright' },
    norm_num: { when: 'concrete numeral arithmetic', compose: 'computes both sides' },
    positivity: { when: 'prove an expression is positive', compose: 'closes sign goals' },
    field_simp: { when: 'equality with fractions over a field', compose: 'clears denominators, then simp' }
};

// Operators that are logical connectives (matter for propositional goals).
export const LOGICAL_OPS = new Set(['→', '↔', '∨', '∧', '¬', '∀', '∃']);
// Arithmetic markers; presence anywhere disqualifies "propositional" (tauto cannot handle them).
const ARITH_RE = /[+\-*\/\^<≤>≥=≠!]/;

// Top-level (paren-depth-0) operator scan. Returns the ordered list of operators seen at depth
// 0; the first is the goal's head connective.
function topLevelOperators(type) {
    const ops = [];
    let depth = 0;
    const chars = [...String(type ?? '')];
    const unicodeOps = ['→', '↔', '∨', '∧', '¬', '∀', '∃', '≠', '≤', '≥'];
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === '(' || ch === '{') { depth++; continue; }
        if (ch === ')' || ch === '}') { depth--; continue; }
        if (depth !== 0) continue;
        if (unicodeOps.includes(ch)) { ops.push(ch); continue; }
        if (ch === '=' || ch === '<' || ch === '>' || ch === ':') { ops.push(ch); continue; }
    }
    return ops;
}

// Goal-shape summary used to pick menu cards. Returns `{ head, tags, propositional, division }`
// where `head` is the first top-level connective, `tags` are logical/arithmetic structure
// present ANYWHERE (including inside a disjunctive hypothesis of an implication), and
// `propositional` is true when the goal is pure propositional logic (no arithmetic markers).
export function goalShape(type) {
    const text = String(type ?? '');
    const top = topLevelOperators(text);
    const head = top[0] ?? null;

    const tags = new Set();
    for (const op of LOGICAL_OPS) {
        if (text.includes(op)) {
            if (op === '→') tags.add('implication');
            if (op === '↔') tags.add('iff');
            if (op === '∨') tags.add('disjunction');
            if (op === '∧') tags.add('conjunction');
            if (op === '¬') tags.add('negation');
            if (op === '∀') tags.add('forall');
        }
    }
    if (text.includes('≠') || text.includes('!=')) tags.add('negation');
    if (top.includes('=') || /[<≤>≥]/.test(text)) tags.add('arithmetic');
    if (text.includes('/')) tags.add('division');

    const propositional = !ARITH_RE.test(text);
    return { head, tags, propositional, division: text.includes('/') };
}

function headIs(head, ops) {
    return ops.includes(head);
}

// Relevance: does a card belong on the menu for this goal shape?
function cardShown(card, s) {
    switch (card) {
        case 'intro': return s.tags.has('implication') || s.tags.has('forall');
        case 'rw': case 'rfl': return s.tags.has('arithmetic') && headIs(s.head, ['=', '≠']);
        case 'cases': case 'rcases': case 'rintro': return s.tags.has('disjunction') || s.tags.has('conjunction') || s.tags.has('implication');
        case 'induction': return s.tags.has('arithmetic') || s.tags.has('forall');
        case 'by_contra': case 'contradiction': return s.tags.has('negation');
        case 'constructor': return headIs(s.head, ['∧']);
        case 'left': case 'right': return headIs(s.head, ['∨']);
        case 'assumption': return !s.tags.has('implication') || s.tags.has('conjunction');
        case 'decide': case 'native_decide': return s.propositional;
        case 'tauto': return s.propositional;
        case 'ring': case 'ring_nf': return s.tags.has('arithmetic') && headIs(s.head, ['=']);
        case 'omega': case 'linarith': case 'nlinarith': return s.tags.has('arithmetic');
        case 'norm_num': return s.tags.has('arithmetic') || /\d/.test(String(s.head ?? ''));
        case 'positivity': return /[<≤>≥]/.test(String(s.type ?? '')) || s.tags.has('arithmetic');
        case 'field_simp': return s.division && headIs(s.head, ['=']);
        default: return true; // exact, apply, simp — always
    }
}

// Available tactics for a statement: core union the module-provided tactics from its imports.
export function availableTactics(statement) {
    const available = new Set(Object.keys(CORE_CARD_META));
    const imports = [...String(statement ?? '').matchAll(/^\s*import\s+(\S+)/gm)].map(m => m[1]);
    for (const mod of imports) {
        for (const t of MODULE_TACTICS[mod] ?? []) available.add(t);
    }
    return available;
}

// Build the hypercompressed, import-verified, shape-keyed menu block for a goal.
export function tacticMenuFor(statement, goalType) {
    const available = availableTactics(statement);
    const s = goalShape(goalType);
    s.type = goalType;

    const cards = [];
    for (const name of ['tauto', 'ring', 'ring_nf', 'omega', 'linarith', 'nlinarith', 'norm_num', 'positivity', 'field_simp', 'decide', 'native_decide']) {
        if (available.has(name) && cardShown(name, s)) cards.push(name);
    }
    for (const name of ['intro', 'cases', 'rcases', 'rintro', 'induction', 'by_contra', 'contradiction', 'constructor', 'left', 'right']) {
        if (available.has(name) && cardShown(name, s)) cards.push(name);
    }
    for (const name of ['exact', 'apply', 'simp', 'rw', 'rfl', 'assumption']) {
        if (available.has(name) && cardShown(name, s)) cards.push(name);
    }
    if (cards.length === 0) return null;

    const shapeLine = shapeSummary(s);
    const lines = ['Tactic menu (import-verified):'];
    if (shapeLine) lines.push(`  Goal shape: ${shapeLine}`);
    for (const name of cards) {
        const meta = MODULE_CARD_META[name] ?? CORE_CARD_META[name] ?? { when: '', compose: '' };
        lines.push(`  - ${name}: ${meta.when} (${meta.compose})`);
    }
    lines.push(`  Also available: ${[...available].filter(t => !cards.includes(t)).sort().join(', ')}`);
    return lines.join('\n');
}

function shapeSummary(s) {
    if (s.propositional && (s.tags.has('implication') || s.tags.has('disjunction') || s.tags.has('conjunction'))) {
        return 'propositional' + (s.tags.has('implication') ? ', implication' : '') + (s.tags.has('disjunction') ? ', disjunction present' : '');
    }
    if (s.tags.has('arithmetic')) {
        const parts = [];
        if (headIs(s.head, ['='])) parts.push('equality');
        if (/[<≤>≥]/.test(String(s.type ?? ''))) parts.push('inequality');
        if (s.division) parts.push('fractions');
        return parts.length ? parts.join(' + ') : 'arithmetic';
    }
    return s.propositional ? 'propositional' : '';
}

// Insert a block into the last user message of any prompt shape, before the "Propose ..."
// imperative (so capability info precedes the instruction). Falls back to appending.
// Shared by the tactic menu and the loop's hint injection (exemplars + predictor warnings).
export function splicePrompt(prompt, blockText) {
    const splice = content => {
        const marker = content.search(/\n+\s*Propose (ONE )?tactic/);
        if (marker === -1) return `${content}\n\n${blockText}`;
        return `${content.slice(0, marker)}\n\n${blockText}${content.slice(marker)}`;
    };
    if (typeof prompt === 'string') return splice(prompt);
    if (prompt && typeof prompt === 'object') {
        if (typeof prompt.user === 'string') return { ...prompt, user: splice(prompt.user) };
        if (Array.isArray(prompt)) {
            return prompt.map((m, i) =>
                m.role === 'user' && i === prompt.length - 1 ? { ...m, content: splice(m.content) } : m
            );
        }
    }
    return prompt;
}

// llm wrapper: injects the import-verified tactic menu into proposal prompts only. Chains with
// PremiseAugmentingLLM by sitting closest to the raw llm (innermost): the premise augmenter
// rebuilds the prompt wholesale, so the menu must be applied AFTER that rebuild.
export class TacticMenuAugmentingLLM {
    constructor(llm, { statement = '' } = {}) {
        if (!llm) throw new Error('TacticMenuAugmentingLLM requires an llm');
        this.llm = llm;
        this.statement = statement;
        this.menus = new Map();
    }

    async complete(prompt, opts = {}) {
        const goalType = parseProposalGoal(prompt);
        if (goalType !== null) {
            if (!this.menus.has(goalType)) {
                this.menus.set(goalType, tacticMenuFor(this.statement, goalType));
            }
            const menu = this.menus.get(goalType);
            if (menu) return this.llm.complete(splicePrompt(prompt, menu), opts);
        }
        return this.llm.complete(prompt, opts);
    }
}
