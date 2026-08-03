// Central telemetry and event bus (architecture.md).
export class EventBus {
    constructor() {
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event) {
        const enriched = {
            id: `evt_${Math.random().toString(36).slice(2, 9)}`,
            t: Date.now(),
            ...event
        };
        for (const listener of this.listeners) {
            try {
                listener(enriched);
            } catch (err) {
                console.error('EventBus listener error:', err);
            }
        }
        return enriched;
    }
}
