# KanForge — Docs Index

Single source of truth per concern. Anything not listed here belongs in exactly one document; if
you need a fact, look it up here first. Do not restate a fact from one doc in another — reference
it instead.

| Document | Owns | Depends on |
|---|---|---|
| `architecture.md` | repo layout, module/file names, API contracts, wire formats, event vocabulary, reward defaults, guardrail spec, Lean backend interface, query API, ported-vs-new | — |
| `research_notes_2026.md` | systems landscape, working tricks, design warnings, source list | — |
| `build_order.md` | phases, deliverables, acceptance criteria, sequencing, staffing, definition of done | architecture (layout, events, reward, guardrails), research_notes (evidence) |
| `blueprint.md` | goal/non-goals, design narrative, Builder reuse map (module inventory), architecture overview, evaluation plan | architecture, research_notes, patterns_from_hct |
| `patterns_from_hct.md` | HCT layer → design-pattern mappings (load-bearing only) | architecture (canonical module paths) |

Editing rule: when a fact changes, edit its owner doc and update *references* (pointers) in the
others — never duplicate the fact.
