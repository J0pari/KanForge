// Bounded event store with causal parent links (architecture.md).
export class EventStore {
    constructor(maxSize = 10000) {
        this.maxSize = maxSize;
        this.events = [];
    }

    append(event) {
        this.events.push(event);
        if (this.events.length > this.maxSize) {
            this.events.shift();
        }
    }

    query(filter = {}) {
        return this.events.filter(e => {
            for (const [key, val] of Object.entries(filter)) {
                if (e[key] !== val) return false;
            }
            return true;
        });
    }

    getCausalChain(eventId) {
        const chain = [];
        let current = this.events.find(e => e.id === eventId);
        while (current) {
            chain.unshift(current);
            current = current.parent ? this.events.find(e => e.id === current.parent) : null;
        }
        return chain;
    }
}
