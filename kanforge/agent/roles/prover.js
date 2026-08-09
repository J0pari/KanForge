// Prover role (architecture.md §7.3): the ensemble's proving unit. Takes a statement and drives
// the TacticLoop to a kernel-verified proof, returning a structured result the coordinator
// (growth/multibody.js) and the critic can consume. Single-owner: the prover is the only agent
// editing its lemma.

import { TacticLoop } from '../loop.js';

export class Prover {
    constructor({ backend, llm, loopOptions = {}, onEvent = null } = {}) {
        if (!backend || !llm) throw new Error('Prover requires a real backend and llm client');
        this.backend = backend;
        this.llm = llm;
        this.loopOptions = loopOptions;
        this.onEvent = onEvent;
    }

    async prove(statement, { lemmaId = null } = {}) {
        const loop = new TacticLoop({
            backend: this.backend,
            llm: this.llm,
            concurrency: 1,
            onEvent: this.onEvent ?? (() => {}),
            ...this.loopOptions
        });
        const id = lemmaId ?? loop.addLemma(statement);
        const outcome = await loop.proveAll();
        if (!outcome.ok) {
            const failed = loop.events().filter(e => e.type === 'lemma_failed' && e.lemmaId === id).pop();
            return { proved: false, lemmaId: id, error: failed?.error?.message ?? 'prover failed', events: loop.events() };
        }
        const verified = loop.events().filter(e => e.type === 'lemma_verified' && e.lemmaId === id).pop();
        return {
            proved: true,
            lemmaId: id,
            proofScript: verified?.proofScript ?? '',
            ms: verified?.ms ?? null,
            metrics: outcome.metrics ?? null,
            events: loop.events()
        };
    }
}
