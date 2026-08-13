// Bounded event store with causal parent links (architecture.md §4).
//
// Durability contract (§4, checkpoint §7): the store is a bounded IN-MEMORY index of the run's
// events. It is indexed (O(1) lookup per id), so `getCausalChain` walks depth, not the whole
// array. The bound is a memory guard, not a persistence mechanism: evicted events (counted in
// `evicted`) can no longer be ancestors, so a chain queried after eviction starts at its oldest
// surviving member — the durable record of the full stream is the telemetry export
// (`optimization/exporter.js`, JSONL) and the checkpoint's event tail, not this structure.
export class EventStore {
    constructor(maxSize = 10000) {
        this.maxSize = maxSize;
        this.events = [];
        this._index = new Map(); // eventId → event
        this.evicted = 0;        // count of events dropped by the bound (telemetry surface)
    }

    append(event) {
        this.events.push(event);
        this._index.set(event.id, event);
        while (this.events.length > this.maxSize) {
            const dropped = this.events.shift();
            this._index.delete(dropped.id);
            this.evicted++;
        }
    }

    get(eventId) {
        return this._index.get(eventId) ?? null;
    }

    query(filter = {}) {
        return this.events.filter(e => {
            for (const [key, val] of Object.entries(filter)) {
                if (e[key] !== val) return false;
            }
            return true;
        });
    }

    // Causal chain by indexed id walk (O(depth)). Truncated at the oldest surviving event when
    // ancestors were evicted — callers that need the full chain read the exported stream.
    getCausalChain(eventId) {
        const chain = [];
        let current = this._index.get(eventId) ?? null;
        while (current) {
            chain.unshift(current);
            current = current.parent ? this._index.get(current.parent) ?? null : null;
        }
        return chain;
    }
}
