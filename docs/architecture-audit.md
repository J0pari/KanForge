# Architecture audit — what is principled, what is fakery, and the decomposition

Date: 2026-08-21. Criterion: every stage of the pipeline must be (a) sound by construction —
the Lean kernel is the only authority for mathematical truth — and (b) general — no stage may
depend on knowledge of any specific theorem, problem, or proof. Operator steering of specific
problems is not a deliverable; it is a defect.

## 0. Status of this session's reversions

Two steering defects were introduced and reverted this session:

- `f4412f6` injected a problem-class-specific "admissible pattern" paragraph (patterns 4/5,
  a classical-theorem remark, all-caps) into `blueprint/skeleton.js`. Reverted in `e4da441`.
- The same reasoning documents patterns (4)/(5) inside the ORACLE partition
  (`oracle/erdos10-two-pows/DAG.md`), which is the only legal home for that knowledge: it is
  an answer key used for grading, and nothing in the pipeline reads it.

The mission run that consumed that prompt was stopped and its run dir archived
(`runs/erdos10-variant-two-pows-ap-attempt`). The current mission dir contains only the intake
artifacts (statement.txt, probes.json) and no checkpoint.

## 1. Inventory by layer

### S0 — Kernel gateway (sound)
`lean/backendRepl.js`, `lean/backendCli.js`, `lean/pin.js`, `lean/moduleResolver.js`,
`lean/symbolIndex.js`. Every mathematical claim in the system is ultimately a repl `check`,
an `applyTactic`, or an `extractGoals` — kernel-decided. The repl process pool has real
hygiene (kill-on-hang, acquire timeouts, warm-env chains, cold-check recycling). Known issues
are environmental (this box: memory pressure, repl parser quirks, provider timeouts), not
architectural. Tests: `backendRepl.test.js` and live repl tests pass.

### S1 — Search (sound, the only legitimate source of DAG growth)
`agent/searchEngine.js`, `agent/loop.js`, `search/*.js` (bfs, mcgs, safeLadder, tacticMenu,
premises, repulsion, swiss, goalMemory). Goal graph with frontier discipline, per-goal tactic
proposals, the deterministic safe ladder, goal memory replay, and a kernel-verified commit
guardrail. Every edge it adds to the proof tree is a kernel-checked tactic application; it
cannot add a false lemma. This is where progress must come from.

### S2 — Structural seed / skeleton (UNPRINCIPLED — the god object)
`blueprint/skeleton.js` currently does ALL of: ask the LLM to plan the whole proof as a DAG
essay; kernel-check stubs; run the falsification gate; write the blueprint; retry the plan;
counsel "deepen" re-splits. Findings:

- The plan-essay invents lemmas the search never asked for. A planned lemma can be false in
  ways bounded counterexample search cannot see (observed this session: the AP-family avoid
  claim — its counterexamples are astronomically large). The pipeline then spends its whole
  budget proving a false DAG, with no structural signal that the PLAN is wrong. This is not a
  tuning problem; the stage's contract is wrong.
- The refine loop's "re-split" calls back into the plan-essay (`skeleton.generate` with
  `priorChildren`), so the unprincipled stage is also the growth engine. The DAG is thus a
  plan being whittled, not a proof tree being grown.
- The prompt is prose policy; it invites exactly the operator patch-loop observed this
  session. It should not exist in its current role or format.

### S3 — Criticism gates (sound)
`blueprint/falsify.js` (bounded counterexample search, kernel-verified witnesses),
`blueprint/run.js` intake gate (kernel-verified instance ledger, fail-closed), the search
guardrail (commit re-verification). These are the right ideas; their limitation (small
instances only) is inherent and acceptable — a gate is not a prover.

### S4 — Memory/reuse (sound)
`agent/reuseEngine.js`, `growth/lemmaStore.js` (canonicalization by shortest-proof normIndex,
rankByGoal tie-break), campaign goal memory. Every transfer is kernel-gated.

### S5 — Accounting and supervision (sound in principle)
`watchdog.mjs` (pass supervision, zero-progress stop), `optimization/kpis.js` (failure
taxonomy: math vs search vs infrastructure), `blueprint/assemble.js` pertinence audit,
`runRecorder`. Resource accounting exists but is not yet consumed as feedback anywhere except
stop conditions. The correct use of telemetry is REPORTING (what was spent where), not a
magic strategy-switcher.

### S6 — Grading (partitioned)
`oracle/` — the answer key and the diff tool. Strictly external; measures distance from a
correct proof; never feeds the pipeline.

## 2. Root findings

1. **The skeleton is a god object whose contract is wrong.** Its planning role must be
   deleted; the DAG must be the emergent proof tree of S1, grown only by kernel-verified
   artifacts (case splits from `cases`/`induction`, subgoals of progressing tactics,
   definitional unfoldings of the statement's own syntax).
2. **No stage is allowed to invent a claim the kernel has not engaged with.** A plan-essay
   necessarily violates this; a search tree cannot.
3. **General-capability evidence is missing.** This session produced component tests (391
   passing) but no end-to-end multi-problem run establishing what the general machine
   actually solves. Until that number exists, every mechanism claim is unproven.
4. **Telemetry is under-consumed as reporting.** The honest escalation is a report: per-lemma
   and per-DAG resource ledgers, surfaced in the pass report — a human (or the ablation
   harness) reads them; no stage may use them to switch to "different strategies" it cannot
   define soundly.

## 3. Target decomposition and contracts

- S0 kernel gateway: the only truth oracle. Contract: `check`, `applyTactic`, `extractGoals`,
  leases. Nothing else may claim `verified`.
- S1 search: grows the DAG. Contract: nodes are created ONLY from (a) the initial seed of S2,
  (b) kernel-verified subgoals. It reports failures to S5, consults S3 and S4, and never
  deletes a kernel-verified edge.
- S2 structural seed: deterministic, LLM-free, ~100 lines. Contract: from the theorem's
  syntax alone, emit (a) the root stub, (b) mechanical unfoldings of the statement's own
  definitions and set-membership conjuncts as stubs — nothing else. No invented constants,
  no lemmas the statement does not mention. (A root-only seed is acceptable; growth is S1's
  job.)
- S3 criticism: falsification and intake gates, unchanged in role; moved out of the skeleton
  to their own call sites.
- S4 memory: unchanged.
- S5 accounting: unchanged; extended with a per-DAG resource ledger in the pass report.
- S6 grading: the oracle diff, unchanged.

Explicitly deleted: the plan-essay prompt, the deepen counselor, the skeleton's retry-the-
plan policy, and any prose policy in prompts that encodes proof-strategy knowledge.

## 4. Sequencing

1. Delete the planner role of `skeleton.js`; replace `generate` with the deterministic
   structural seed (S2); remove the refine re-split's call into plan generation; re-splits
   become S1-only (case splits on stalled goals, kernel-checked children).
2. Run the general benchmark set end-to-end (bench smoke + ablation problem set) and record
   the honest pass rates. This is the baseline number every later change is judged against.
3. Fix per-subsystem gaps found by real multi-problem failures — one mechanism at a time,
   each with a test and a baseline-comparison note.
4. Grade the erdos10 mission with the oracle diff; treat it as ONE data point of a general
   machine on a research-level theorem, not as a goal the pipeline is entitled to reach.

The mission stays stopped until step 1 lands and step 2 has a number.
