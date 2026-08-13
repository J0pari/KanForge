// Goal-type TERM PARSER (architecture.md §2.2, build_order.md §5.12): turns the pretty-printed
// goal type text (as the repl reports it) into a term tree the e-graph reasons over.
//
// Term model (e-node children are terms):
//   { kind: 'const', name }                      — named constant / free variable
//   { kind: 'app', fn: Term, args: Term[] }      — application (args include explicit/implicit)
//   { kind: 'arrow', domain: Term, body: Term }  — A → B
//   { kind: 'forall', binders: Binder[], body: Term } — Π (∀ / implicit {…} / instance […])
//   { kind: 'exists', binders: Binder[], body: Term }
//   { kind: 'num', value: string }               — numeral literal
//   { kind: 'opaque', text }                     — unparseable input: ONE leaf, no structure
//   Binder = { name: string, type: Term, pred?: '∈'|'⊆'|null } — pred-binders (∀ x ∈ s, …) keep
//            their predicate marker so they never merge with plain binders.
//
// CONSERVATIVE CONTRACT: the parser returns `null` (→ opaque leaf) on anything it cannot parse
// with certainty. A wrong parse would let the e-graph merge non-equivalent goals; a failed
// parse only loses merging. Structural safety is absolute; coverage is best-effort.
//
// `termToText` reconstructs canonical text for oracle queries (`example : (lhs) = (rhs) := by
// rfl`), so the kernel sees the exact pair the e-graph wants to union.

// Unicode → canonical names, so printed forms from any backend tokenize identically.
const UNICODE_NAMES = {
    'ℕ': 'Nat', 'ℤ': 'Int', 'ℚ': 'Rat', 'ℝ': 'Real', 'ℂ': 'Complex',
    '∀': 'forall', '∃': 'exists', '→': 'imp', '↔': 'Iff',
    '∧': 'And', '∨': 'Or', '¬': 'Not',
    '≠': 'Ne', '≤': 'Le', '≥': 'Ge', '<': 'Lt', '>': 'Gt', '=': 'Eq',
    '∈': 'Mem', '⊆': 'Subset', '⊂': 'SSubset', '×': 'Prod', '∘': 'Comp',
    '·': 'SMul.smul', '•': 'SMul.smul', '⊢': '', '⟨': '(', '⟩': ')',
    'Σ': 'Finset.sum', '∏': 'Finset.prod', '≤': 'Le', '⊤': 'Top', '⊥': 'Bot',
    '₀': '0', '₁': '1', '₂': '2', '₃': '3'
};

const OPERATOR_SYMS = new Set(['imp', 'Iff', 'And', 'Or', 'Not', 'Ne', 'Le', 'Ge', 'Lt', 'Gt',
    'Eq', 'Mem', 'Subset', 'SSubset', 'Prod', 'Comp']);

export function tokenize(text) {
    const tokens = [];
    let i = 0;
    const s = String(text ?? '');
    const push = (kind, value) => tokens.push({ kind, value });
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        // Numerals
        if (/[0-9]/.test(c)) {
            let j = i;
            while (j < s.length && /[0-9]/.test(s[j])) j++;
            push('num', s.slice(i, j));
            i = j;
            continue;
        }
        // Identifiers (ASCII letters/_/'/. and unicode letters)
        if (/[A-Za-z_]/.test(c) || /[\p{L}]/u.test(c)) {
            let j = i;
            while (j < s.length && (/[A-Za-z0-9_.']/.test(s[j]) || /[\p{L}]/u.test(s[j]))) j++;
            let name = s.slice(i, j);
            for (const [u, a] of Object.entries(UNICODE_NAMES)) {
                if (name === u) { name = a; break; }
            }
            push('id', name);
            i = j;
            continue;
        }
        // Unicode symbols → operator names
        if (Object.prototype.hasOwnProperty.call(UNICODE_NAMES, c)) {
            const name = UNICODE_NAMES[c];
            if (!name) { i++; continue; }
            push('op', name);
            i++;
            continue;
        }
        // ASCII multi-char ops
        if (s.startsWith('->', i)) { push('op', 'imp'); i += 2; continue; }
        if (s.startsWith('<->', i)) { push('op', 'Iff'); i += 3; continue; }
        if (s.startsWith('/\\', i)) { push('op', 'And'); i += 2; continue; }
        if (s.startsWith('\\/', i)) { push('op', 'Or'); i += 2; continue; }
        if (s.startsWith('<=', i)) { push('op', 'Le'); i += 2; continue; }
        if (s.startsWith('>=', i)) { push('op', 'Ge'); i += 2; continue; }
        if (s.startsWith('<>', i)) { push('op', 'Ne'); i += 2; continue; }
        if ('(){}[],:'.includes(c)) { push('punct', c); i++; continue; }
        if ('+-*/^=<>'.includes(c)) {
            const map = { '+': 'HAdd.hAdd', '-': 'HSub.hSub', '*': 'HMul.hMul', '/': 'HDiv.hDiv',
                '^': 'HPow.hPow', '=': 'Eq', '<': 'Lt', '>': 'Gt' };
            push('op', map[c]);
            i++;
            continue;
        }
        return null; // unknown character: conservatively unparseable
    }
    return tokens;
}

export class TermParser {
    constructor(text) {
        this.tokens = tokenize(text);
        this.pos = 0;
        this.failed = this.tokens === null;
    }

    peek() { return this.tokens[this.pos] ?? null; }
    next() { return this.tokens[this.pos++] ?? null; }

    fail() { this.failed = true; return null; }

    // type := forall | exists | arrow
    parseType() {
        if (this.failed) return null;
        const t = this.peek();
        if (t?.kind === 'op' && (t.value === 'forall' || t.value === 'exists')) return this.parseBinderType(t.value);
        if (t?.kind === 'id' && (t.value === 'forall' || t.value === 'exists')) return this.parseBinderType(t.value);
        return this.parseArrow();
    }

    parseBinderType(kind) {
        // Consume the quantifier token (op '∀'/'∃' or the ASCII id form).
        this.next();
        const binders = [];
        // After ∀: binder group(s) until ',' then the body.
        let t = this.peek();
        if (!t) return this.fail();
        while (t && !(t.kind === 'punct' && t.value === ',')) {
            // Bare single binder without parentheses: `∀ n : ℕ, …`
            if (t.kind === 'id' && this.tokens[this.pos + 1]?.kind === 'punct' && this.tokens[this.pos + 1].value === ':') {
                const name = this.next().value;
                this.next(); // ':'
                const type = this.parseArrow();
                if (!type) return this.fail();
                binders.push({ name, type, pred: null });
                t = this.peek();
                continue;
            }
            // Bare predicate binder: `∀ x ∈ s, …` (no parentheses)
            if (t.kind === 'id' && this.tokens[this.pos + 1]?.kind === 'op' &&
                (this.tokens[this.pos + 1].value === 'Mem' || this.tokens[this.pos + 1].value === 'Subset')) {
                const name = this.next().value;
                const op = this.next().value;
                const predTerm = this.parseArrow();
                if (!predTerm) return this.fail();
                binders.push({ name, type: predTerm, pred: op === 'Mem' ? '∈' : '⊆' });
                t = this.peek();
                continue;
            }
            const b = this.parseBinderGroup();
            if (!b) return this.fail();
            binders.push(...b);
            t = this.peek();
        }
        if (!(t && t.kind === 'punct' && t.value === ',')) return this.fail();
        this.next(); // ','
        const body = this.parseType();
        if (!body) return this.fail();
        return { kind, binders, body };
    }

    // (id+ : type) | {id+ : type} | [type] | (id ∈ term) | (id ⊆ term)
    parseBinderGroup() {
        const t = this.peek();
        if (!t) return this.fail();
        if (t.kind === 'punct' && t.value === '[') {
            this.next();
            const type = this.parseArrow();
            if (!type) return this.fail();
            const close = this.next();
            if (!(close && close.kind === 'punct' && close.value === ']')) return this.fail();
            return [{ name: null, type, pred: null }]; // instance implicit binder
        }
        if (t.kind === 'punct' && (t.value === '(' || t.value === '{')) {
            this.next();
            const names = [];
            // Consecutive ids form a grouped binder telescope `(a b c : T)`; a name directly
            // followed by ':' or a binder-predicate op ends the name list.
            while (this.peek() && this.peek().kind === 'id' && names.length < 16) {
                const lookahead = this.tokens[this.pos + 1];
                if (!lookahead) return this.fail();
                names.push(this.next().value);
                if (lookahead.kind === 'punct' && lookahead.value === ':') {
                    this.next();
                    const type = this.parseArrow();
                    if (!type) return this.fail();
                    const close = this.next();
                    if (!(close && close.kind === 'punct' && (close.value === ')' || close.value === '}'))) return this.fail();
                    return names.map(name => ({ name, type, pred: null }));
                }
                if (lookahead.kind === 'op' && (lookahead.value === 'Mem' || lookahead.value === 'Subset')) {
                    const op = this.next().value;
                    const predTerm = this.parseArrow();
                    if (!predTerm) return this.fail();
                    const close = this.next();
                    if (!(close && close.kind === 'punct' && close.value === ')')) return this.fail();
                    return names.map(name => ({ name, type: predTerm, pred: op === 'Mem' ? '∈' : '⊆' }));
                }
                if (lookahead.kind !== 'id') break; // the name list continues only on more ids
            }
            // Anonymous binder group: a bare term in parentheses/braces.
            const type = this.parseArrow();
            if (!type) return this.fail();
            const close = this.next();
            if (!(close && close.kind === 'punct' && (close.value === ')' || close.value === '}'))) return this.fail();
            return [{ name: null, type, pred: null }];
        }
        return this.fail();
    }

    // arrow := expr ('→' type)?   (right-assoc)
    parseArrow() {
        const domain = this.parseExpr(0);
        if (!domain) return this.fail();
        const t = this.peek();
        if (t && t.kind === 'op' && t.value === 'imp') {
            this.next();
            const body = this.parseType();
            if (!body) return this.fail();
            return { kind: 'arrow', domain, body };
        }
        return domain;
    }

    // Precedence-climbing expression parser over binary operators (all left-assoc).
    // Tiers: Or < And < comparisons (= ≠ < ≤ > ≥ ∈ ⊆) < add/sub < mul/div < pow.
    parseExpr(minTier) {
        let left = this.parseUnary();
        if (!left) return this.fail();
        for (;;) {
            const t = this.peek();
            if (!(t && t.kind === 'op')) break;
            const tier = BIN_PRECEDENCE[t.value] ?? -1;
            if (tier < minTier || tier < 0) break;
            this.next();
            const right = this.parseExpr(tier + 1); // left-assoc: right side binds strictly tighter
            if (!right) return this.fail();
            left = { kind: 'app', fn: { kind: 'const', name: t.value }, args: [left, right] };
        }
        return left;
    }

    parseUnary() {
        const t = this.peek();
        if (t && t.kind === 'op' && (t.value === 'Not' || t.value === 'HSub.hSub')) {
            this.next();
            const arg = this.parseUnary();
            if (!arg) return this.fail();
            return { kind: 'app', fn: { kind: 'const', name: t.value }, args: [arg] };
        }
        return this.parseApplication();
    }

    parseApplication() {
        const head = this.parseAtom();
        if (!head) return this.fail();
        // Juxtaposition application: atom atom* — but only while the next token can START an
        // atom and is not an operator that would belong to a surrounding binary parse.
        const args = [];
        for (;;) {
            const t = this.peek();
            if (!t) break;
            if (t.kind === 'op') break; // operators end the application (binary op or done)
            if (t.kind === 'punct' && t.value === ',') break;
            if (t.kind === 'punct' && (t.value === ')' || t.value === '}' || t.value === ']')) break;
            const arg = this.parseAtom();
            if (!arg) break;
            args.push(arg);
        }
        if (args.length === 0) return head;
        return { kind: 'app', fn: head, args };
    }

    parseAtom() {
        const t = this.peek();
        if (!t) return this.fail();
        if (t.kind === 'num') { this.next(); return { kind: 'num', value: t.value }; }
        if (t.kind === 'id') {
            this.next();
            // Sort u: `Type u` / `Prop` — Type followed by an atom is application (handled by
            // parseApplication via args); plain ids are constants/free variables.
            return { kind: 'const', name: t.value };
        }
        if (t.kind === 'op') {
            // Unary-ish operators inside applications (e.g. ¬ within parseUnary handles Not;
            // HSub.hSub minus is unary too) — an op here means a bare operator constant is not
            // a valid atom in this grammar.
            return this.fail();
        }
        if (t.kind === 'punct' && t.value === '(') {
            this.next();
            const inner = this.parseType();
            if (!inner) return this.fail();
            const close = this.next();
            if (!(close && close.kind === 'punct' && close.value === ')')) return this.fail();
            return inner;
        }
        if (t.kind === 'punct' && t.value === '{') {
            // Implicit argument: either a binder group `{α : Type u}` or a bare implicit term.
            const saved = this.pos;
            const binders = this.parseBinderGroup();
            if (binders && binders.length && binders[0].name != null) {
                return { kind: 'implicit', term: { kind: 'binderGroup', binders } };
            }
            this.pos = saved;
            this.next(); // '{'
            const inner = this.parseType();
            if (!inner) return this.fail();
            const close = this.next();
            if (!(close && close.kind === 'punct' && close.value === '}')) return this.fail();
            return { kind: 'implicit', term: inner };
        }
        if (t.kind === 'punct' && t.value === '[') {
            this.next();
            const inner = this.parseType();
            if (!inner) return this.fail();
            const close = this.next();
            if (!(close && close.kind === 'punct' && close.value === ']')) return this.fail();
            return { kind: 'instance', term: inner };
        }
        return this.fail();
    }
}

const BIN_PRECEDENCE = {
    'Iff': 1, 'Or': 1, 'And': 2,
    'Eq': 3, 'Ne': 3, 'Lt': 3, 'Le': 3, 'Gt': 3, 'Ge': 3, 'Mem': 3, 'Subset': 3, 'SSubset': 3,
    'HAdd.hAdd': 4, 'HSub.hSub': 4,
    'HMul.hMul': 5, 'HDiv.hDiv': 5,
    'HPow.hPow': 6
};

// Internal const name → printed symbol, so oracle queries show real Lean surface syntax.
const PRINT_SYM = {
    'HAdd.hAdd': '+', 'HSub.hSub': '-', 'HMul.hMul': '*', 'HDiv.hDiv': '/', 'HPow.hPow': '^',
    'Eq': '=', 'Ne': '≠', 'Lt': '<', 'Le': '≤', 'Gt': '>', 'Ge': '≥',
    'Mem': '∈', 'Subset': '⊆', 'SSubset': '⊂', 'And': '∧', 'Or': '∨', 'Not': '¬',
    'Iff': '↔', 'Prod': '×', 'Comp': '∘', 'SMul.smul': '•'
};

// Parse a goal type string; null → caller falls back to an opaque leaf.
export function parseGoalType(typeText) {
    const parser = new TermParser(typeText);
    const term = parser.parseType();
    if (!term || parser.failed || parser.pos < parser.tokens.length) return null;
    return term;
}

// Canonical text reconstruction (for oracle queries + opaque-leaf hashing). Output is valid
// Lean surface syntax for the shapes the parser accepts, with parentheses added exactly where
// precedence demands — the printed form must re-parse to the same tree.
export function termToText(term) {
    if (!term) return '';
    switch (term.kind) {
        case 'const': return term.name;
        case 'num': return term.value;
        case 'opaque': return term.text;
        case 'implicit': return term.term.kind === 'binderGroup'
            ? `{${term.term.binders.map(b => `${b.name} : ${termToText(b.type)}`).join(' ')}}`
            : `{${termToText(term.term)}}`;
        case 'instance': return `[${termToText(term.term)}]`;
        case 'arrow': return `${termToText(term.domain)} → ${termToText(term.body)}`;
        case 'forall':
        case 'exists': {
            const binders = term.binders.map(b => {
                if (b.name == null) return `[${termToText(b.type)}]`;
                if (b.pred === '∈') return `(${b.name} ∈ ${termToText(b.type)})`;
                if (b.pred === '⊆') return `(${b.name} ⊆ ${termToText(b.type)})`;
                return `(${b.name} : ${termToText(b.type)})`;
            }).join(' ');
            const kw = term.kind === 'forall' ? '∀' : '∃';
            return `${kw} ${binders}, ${termToText(term.body)}`;
        }
        case 'app': {
            const fnName = term.fn?.kind === 'const' ? term.fn.name : null;
            // Binary infix application with a symbol.
            if (fnName && BIN_PRECEDENCE[fnName] != null && term.args.length === 2) {
                const sym = PRINT_SYM[fnName] ?? fnName;
                const tier = BIN_PRECEDENCE[fnName];
                const wrap = (child, side) => {
                    const t = termToText(child);
                    if (child?.kind !== 'app' || child.fn?.kind !== 'const') return t;
                    const ctier = BIN_PRECEDENCE[child.fn.name] ?? -1;
                    if (ctier < 0) return t;
                    // left-assoc: same tier on the left needs no parens; right child at the same
                    // tier DOES need them (a - (b - c) ≠ a - b - c).
                    if (ctier > tier) return t;
                    if (ctier === tier && side === 'left') return t;
                    return `(${t})`;
                };
                return `${wrap(term.args[0], 'left')} ${sym} ${wrap(term.args[1], 'right')}`;
            }
            // Unary prefix: ¬ / negation parenthesize infix children.
            if ((fnName === 'Not' || fnName === 'HSub.hSub') && term.args.length === 1) {
                const sym = PRINT_SYM[fnName] ?? fnName;
                const child = term.args[0];
                const t = termToText(child);
                const isInfix = child?.kind === 'app' && child.fn?.kind === 'const' &&
                    BIN_PRECEDENCE[child.fn.name] != null;
                return isInfix ? `${sym} (${t})` : `${sym} ${t}`;
            }
            return `${termToText(term.fn)} ${term.args.map(termToText).join(' ')}`.trim();
        }
        default: return String(term.text ?? '');
    }
}
