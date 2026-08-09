# KanForge Open-Problem Corpus Index (build_order.md §7.0)

This index records the human-curated open-problem sources that qualify as mission intake.
Rule per §7.0: the corpus is human-authored/human-approved; the agent never curates targets.
Each source is a PRIMARY source (original author, site owner, or machine-readable database of
same), stored verbatim under `sources/`. Wikipedia and other tertiary indices are NOT sources.

## Sources

| id | Source | Primary? | License | Local path | Status |
|---|---|---|---|---|---|
| erdosproblems-db | teorth/erdosproblems — community DB of erdosproblems.com (1,217 problems, status/OEIS/tags/formalized) | Primary (T. F. Bloom's erdosproblems.com + Tao's DB) | Apache-2.0 | `sources/erdosproblems-db/` (cloned, git sha pinned) | INTAKE READY |
| erdosproblems-site | erdosproblems.com per-problem pages — verbose human-written statements + citations + DeepMind formal-conjecture links | Primary | site TOS | fetch-on-demand; record statements under `sources/` | INTAKE READY |

## Candidate selection (shortlist) rules — per §7.1

For any mission, the agent:
1. selects CANDIDATES from a source above (filter: informal_status=open, formalized=yes preferred);
2. formalizes each candidate (kernel typecheck, probes, consensus);
3. presents a SHORTLIST with justification (formalizability, substrate cost, shape per §0.2,
   novelty, no-known-proof evidence) to the human;
4. the HUMAN selects the mission target.

## Recorded error (do not repeat)

An agent-picked "open problem" run was attempted on `mul_le_mul_nat` (a mathlib lemma with a
known proof). That is a harness problem, not a mission. This index + the §7.0 gate exist to make
the distinction mechanical.
