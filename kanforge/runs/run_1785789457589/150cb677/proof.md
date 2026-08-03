# Proof Writeup: 150cb677d9a4b148ace677c49675435241ec9520867c3bd6a4b94a648d86e6b8

## Statement
```lean
example (a b c : Nat) (h : a < b) (h2 : b < c) : a < c := by sorry
```

## Proof
```lean
by
  omega
```

## Dependencies
- (none)

## Metrics
- Tactics per lemma: 1
- Tactic success rate: 1

## Event Summary
Total events: 6
Tactics proposed: 1
Tactics applied: 1
Goals solved: 1
