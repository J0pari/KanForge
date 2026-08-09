// Degeneracy / reward-hacking monitors (architecture.md §6, blueprint.md §6.2).
// A pure function of the event stream (same contract as metrics.js — never calls the backend or
// LLM). Detects the failure modes that indicate the loop is not genuinely progressing:
//   - error_cluster: bursts of identical tactic failures
//   - same_failure_cycle: the same lemma/goal failing with the same error repeatedly
//   - repair_loop: the repair path failing on the same goal class in a row
//   - stuck_proposal: the LLM re-proposing the identical tactic on the same goal class
//   - guardrail_spike: guardrail trips clustering in the tail of the run
//   - degradation: lemma success rate falling off in the second half of the run
//   - budget_exhaustion: repeated hard budget failures (no progress, only cost)
// The observations feed the guardrail layer and the reward refresh loop (§6.4) — a run with a
// critical pattern is a signal to re-tune, not to keep spending.

const SEVERITY = { warn: 'warn', critical: 'critical' };

function normError(msg) {
    return String(msg ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function safeErr(e) {
    return e?.error?.message ?? e?.error ?? e?.message ?? '';
}

function windowSlice(events, fraction, fromEnd = true) {
    if (events.length === 0) return [];
    const size = Math.max(1, Math.floor(events.length * fraction));
    return fromEnd ? events.slice(-size) : events.slice(0, size);
}

// Detect runs of consecutive identical values.
function consecutiveRuns(list, min, key) {
    const runs = [];
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
        if (i === list.length || key(list[i]) !== key(list[start])) {
            if (i - start >= min) runs.push({ count: i - start, first: start, last: i - 1, key: key(list[start]) });
            start = i;
        }
    }
    return runs;
}

export function analyzePatterns(events = [], opts = {}) {
    const clusterMin = opts.clusterMin ?? 3;
    const repairLoopMin = opts.repairLoopMin ?? 3;
    const stuckMin = opts.stuckMin ?? 4;
    const spikeWindowFraction = opts.spikeWindowFraction ?? 0.25;
    const spikeRatio = opts.spikeRatio ?? 2;
    const degradationFactor = opts.degradationFactor ?? 0.7;
    const observations = [];

    const tacticFailed = events.filter(e => e.type === 'tactic_failed' || e.type === 'repair_failed');
    const tacticFailedRuns = consecutiveRuns(tacticFailed, clusterMin, e => normError(safeErr(e)));
    for (const run of tacticFailedRuns) {
        if (run.key === '') continue;
        observations.push({
            type: 'error_cluster',
            severity: SEVERITY.warn,
            count: run.count,
            message: `${run.count} consecutive failures with the same error: "${run.key}"`,
            evidence: tacticFailed.slice(run.first, run.last + 1).map(e => e.id).filter(Boolean)
        });
    }

    // same_failure_cycle: the same lemma failing twice (same statement, same failure signature)
    const failedByLemma = new Map();
    for (const e of events) {
        if (e.type === 'lemma_failed') {
            const sig = normError(e.error?.message ?? e.error ?? '');
            if (!failedByLemma.has(e.lemmaId)) failedByLemma.set(e.lemmaId, []);
            failedByLemma.get(e.lemmaId).push(sig);
        }
    }
    for (const [lemmaId, sigs] of failedByLemma) {
        if (sigs.length >= 2) {
            const uniq = new Set(sigs);
            observations.push({
                type: 'same_failure_cycle',
                severity: SEVERITY.critical,
                count: sigs.length,
                message: `lemma ${String(lemmaId).slice(0, 12)}… failed ${sigs.length} times${uniq.size === 1 ? ' with the same failure' : ''}`,
                evidence: { lemmaId, signatures: [...uniq] }
            });
        }
    }

    // repair_loop: consecutive repair_failed on the same goal class
    const repairFailed = events.filter(e => e.type === 'repair_failed');
    const repairRuns = consecutiveRuns(repairFailed, repairLoopMin, e => String(e.goalClassId ?? e.lemmaId));
    for (const run of repairRuns) {
        observations.push({
            type: 'repair_loop',
            severity: SEVERITY.warn,
            count: run.count,
            message: `${run.count} consecutive repair failures on the same goal class`,
            evidence: repairFailed.slice(run.first, run.last + 1).map(e => e.id).filter(Boolean)
        });
    }

    // stuck_proposal: identical tactic proposed repeatedly on the same goal class
    const proposed = events.filter(e => e.type === 'tactic_proposed' || e.type === 'repair_proposed');
    const proposalRuns = consecutiveRuns(proposed, stuckMin, e => `${e.goalClassId ?? ''}|${String(e.tactic ?? '').trim()}`);
    for (const run of proposalRuns) {
        const [goalClassId, tactic] = run.key.split('|');
        observations.push({
            type: 'stuck_proposal',
            severity: SEVERITY.warn,
            count: run.count,
            message: `the LLM re-proposed "${tactic}" ${run.count} times on goal class ${goalClassId}`,
            evidence: proposed.slice(run.first, run.last + 1).map(e => e.id).filter(Boolean)
        });
    }

    // guardrail_spike: trips clustering in the tail beyond the run's own baseline
    const trips = events.filter(e => e.type === 'guardrail_trip');
    if (trips.length >= 3) {
        const tail = windowSlice(events, spikeWindowFraction).filter(e => e.type === 'guardrail_trip').length;
        const whole = trips.length;
        const baselineRate = whole / Math.max(1, events.length);
        const tailRate = tail / Math.max(1, windowSlice(events, spikeWindowFraction).length);
        if (tailRate > spikeRatio * baselineRate && tail >= 2) {
            observations.push({
                type: 'guardrail_spike',
                severity: SEVERITY.critical,
                count: tail,
                message: `${tail} guardrail trips in the tail (${tailRate.toFixed(3)}/event vs baseline ${baselineRate.toFixed(3)})`,
                evidence: { tailTrips: tail, totalTrips: whole }
            });
        }
    }

    // degradation: success rate in the second half below a factor of the first half
    const halves = [windowSlice(events, 0.5, false), windowSlice(events, 0.5, true)];
    const rates = halves.map(h => {
        const verified = h.filter(e => e.type === 'lemma_verified').length;
        const failed = h.filter(e => e.type === 'lemma_failed').length;
        return { verified, failed, rate: verified / Math.max(1, verified + failed) };
    });
    if (rates[0].verified + rates[0].failed >= 2 && rates[1].verified + rates[1].failed >= 2 && rates[1].rate < degradationFactor * rates[0].rate) {
        observations.push({
            type: 'degradation',
            severity: SEVERITY.critical,
            count: rates[1].verified + rates[1].failed,
            message: `success rate fell from ${(rates[0].rate * 100).toFixed(0)}% (first half) to ${(rates[1].rate * 100).toFixed(0)}% (second half)`,
            evidence: { firstHalf: rates[0], secondHalf: rates[1] }
        });
    }

    // budget_exhaustion: hard budget failures — cost without progress
    const budgetFails = events.filter(e => e.type === 'lemma_failed' && /exhausted|budget|after .* attempts/.test(normError(e.error?.message ?? e.error ?? '')));
    if (budgetFails.length >= 2) {
        observations.push({
            type: 'budget_exhaustion',
            severity: SEVERITY.warn,
            count: budgetFails.length,
            message: `${budgetFails.length} lemmas exhausted their budget without solving`,
            evidence: budgetFails.map(e => e.lemmaId).filter(Boolean)
        });
    }

    // reward_hacking_signal: any guardrail trip is a caught rule-violation attempt
    const tripTypes = [...new Set(trips.map(e => e.violation?.type).filter(Boolean))];
    if (tripTypes.length > 0) {
        observations.push({
            type: 'reward_hacking_signal',
            severity: SEVERITY.critical,
            count: trips.length,
            message: `guardrails caught rule violations: ${tripTypes.join(', ')}`,
            evidence: { types: tripTypes }
        });
    }

    observations.sort((a, b) => (SEVERITY[a.severity] === SEVERITY[b.severity] ? b.count - a.count : (SEVERITY[a.severity] === 'critical' ? -1 : 1)));
    const signature = [...new Set(observations.map(o => o.type))].sort().join(',');
    const critical = observations.filter(o => o.severity === 'critical');
    return {
        observations,
        summary: {
            signature: signature || 'clean',
            criticalCount: critical.length,
            warnCount: observations.length - critical.length
        },
        ok: critical.length === 0
    };
}
