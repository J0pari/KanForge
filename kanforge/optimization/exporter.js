// Telemetry export (architecture.md §6, blueprint.md). Writes a run's causal event stream and
// KPI summary to disk as JSONL (events) + JSON (summary), so a run is inspectable and
// reproducible after the fact without the live process. Toggleable: `exportTo` on the loop, or
// `--export-to=` on blueprint/run.js. The exporter never re-derives facts — it serializes the
// store's events and the metrics object the loop already computed.

import fs from 'node:fs';
import path from 'node:path';

export function exportTelemetry({ file, events = [], metrics = null, meta = {} } = {}) {
    if (!file) throw new Error('exportTelemetry requires a file path');
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const lines = events.map(e => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
    fs.writeFileSync(file, lines, 'utf8');
    const summaryFile = file.replace(/\.jsonl$/i, '') + '.summary.json';
    fs.writeFileSync(summaryFile, JSON.stringify({ meta, metrics, eventCount: events.length, exportedAt: new Date().toISOString() }, null, 2), 'utf8');
    return { events: file, summary: summaryFile };
}
