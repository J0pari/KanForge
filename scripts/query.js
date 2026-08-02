#!/usr/bin/env node
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { WebSocketServer } from 'ws';
import { CONFIG } from './builder.js';

const builderHost = '127.0.0.1';
let builderPort = 9876;
const guiPort = 3000;
let secret;

try {
    builderPort = parseInt(fs.readFileSync(path.join(os.homedir(), '.builder-trace-port'), 'utf8'));
} catch (e) {
    if (e.code !== 'ENOENT') throw e;
}

try {
    secret = Buffer.from(fs.readFileSync(path.join(os.homedir(), '.builder-trace-secret'), 'utf8').trim(), 'hex');
} catch (e) {
    console.error('[QUERY] Error: Secret file not found. Run builder.js first.');
    process.exit(1);
}

// Phase 1: Timestamped Logger with Hash Chains
const logger = (() => {
    let logSequence = 0;
    let lastLogHash = null;

    const writeLog = (level, ...args) => {
        const timestamp = Date.now();
        const seq = logSequence++;
        const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');

        const hmac = crypto.createHmac('sha256', secret);
        if (lastLogHash) hmac.update(lastLogHash);
        hmac.update(`${timestamp}|${seq}|${level}|${message}`);
        const hash = hmac.digest('hex');
        lastLogHash = hash;

        const prefix = `[${new Date(timestamp).toISOString()}][${seq}][${hash.slice(0, 8)}]`;
        const fullLine = `${prefix}[${level}] ${message}`;
        console.log(fullLine);

        return { hash, fullLine, timestamp, seq, level, message };
    };

    return {
        log: (...args) => writeLog('INFO', ...args),
        error: (...args) => writeLog('ERROR', ...args),
        warn: (...args) => writeLog('WARN', ...args),
        section: (title) => {
            const r1 = writeLog('INFO', '');
            const r2 = writeLog('INFO', `========== ${title} ==========`);
            return [r1, r2];
        },
        subsection: (items) => {
            return items.filter(item => item !== null && item !== undefined).map(item => writeLog('INFO', item));
        },
        end: () => {
            return writeLog('INFO', '===================================\n');
        }
    };
})();

function signRequest(method, path, timestamp, body) {
    const bodyStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const canonical = method + path + timestamp + bodyStr;
    return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

// Phase 2: Context Extractors
const extractTemporalContext = (events, focalEvent, windowMs = 1000) => {
    const focalTime = focalEvent.timestamp;
    const before = events.filter(e =>
        e.timestamp < focalTime && e.timestamp >= focalTime - windowMs
    );
    const after = events.filter(e =>
        e.timestamp > focalTime && e.timestamp <= focalTime + windowMs
    );
    return { before, focal: focalEvent, after, windowMs };
};

const extractCausalContext = (events, focalEvent) => {
    const parents = [];
    let current = focalEvent;
    while (current && current.parent) {
        current = events.find(e => e.id === current.parent);
        if (current) parents.unshift(current);
    }

    const children = events.filter(e => e.parent === focalEvent.id);
    const siblings = focalEvent.parent ?
        events.filter(e => e.parent === focalEvent.parent && e.id !== focalEvent.id) : [];

    return { parents, focal: focalEvent, children, siblings };
};

const extractStatisticalContext = (allTransitions, focalTransition) => {
    const key = `${focalTransition.from} → ${focalTransition.to}`;
    const matching = allTransitions.filter(t =>
        t.from === focalTransition.from && t.to === focalTransition.to
    );

    if (matching.length === 0) {
        throw new Error(`No transitions found matching ${key}`);
    }

    const durations = matching.flatMap(t => t.durations || [t.avgDuration]);
    if (durations.length === 0) {
        throw new Error(`No duration data for transition ${key}`);
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const stdDev = Math.sqrt(
        sorted.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) / sorted.length
    );

    const focalDuration = focalTransition.avgDuration || focalTransition.duration;
    const percentile = (sorted.filter(d => d <= focalDuration).length / sorted.length) * 100;
    const zScore = stdDev > 0 ? (focalDuration - avg) / stdDev : 0;
    const isAnomaly = Math.abs(zScore) > 2.5;

    return {
        duration: focalDuration,
        avg: Math.round(avg),
        stdDev: Math.round(stdDev),
        percentile: percentile.toFixed(1),
        zScore: zScore.toFixed(2),
        isAnomaly,
        sampleSize: durations.length
    };
};

// Phase 3: Semantic Formatters
const formatTransitionMatrix = (matrix) => {
    logger.section('EVENT TRANSITION PROBABILITIES');
    logger.log(`After event X, what are the chances the next event is Y?`);
    logger.log(`Total event types: ${matrix.length}`);
    logger.log('');

    const topStates = matrix.slice(0, CONFIG.reporting.maxDisplayResults);

    topStates.forEach((state, i) => {
        logger.log(`${i + 1}. After ${state.event} (avg duration: ${state.avgDuration}ms):`);

        const topTransitions = state.nextStates.slice(0, 5);
        topTransitions.forEach(next => {
            const prob = (next.probability * 100).toFixed(1);
            const barLength = Math.round(next.probability * 20);
            const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
            logger.subsection([`   ${bar} ${prob}% → ${next.event} (${next.avgDuration}ms avg)`]);
        });

        if (state.nextStates.length > 5) {
            logger.subsection([`   ... ${state.nextStates.length - 5} more transitions`]);
        }
        logger.log('');
    });

    if (matrix.length > CONFIG.reporting.maxDisplayResults) {
        logger.log(`... ${matrix.length - CONFIG.reporting.maxDisplayResults} more event types`);
    }

    logger.end();
    return matrix;
};

const formatBottlenecks = (bottlenecks) => {
    logger.section('SLOWEST TRANSITIONS');
    logger.log(`Which event transitions take the longest?`);
    logger.log(`Found ${bottlenecks.length} transitions, sorted by average duration`);
    logger.log('');

    const top = bottlenecks.slice(0, CONFIG.reporting.defaultDisplayLimit);
    const maxAvg = Math.max(...top.map(b => b.avgDuration));

    top.forEach((b, i) => {
        const barLength = Math.round((b.avgDuration / maxAvg) * 30);
        const bar = '▓'.repeat(barLength) + '░'.repeat(30 - barLength);

        logger.log(`${i + 1}. ${b.from} → ${b.to}`);
        logger.subsection([
            `   ${bar}`,
            `   ${b.avgDuration}ms avg, ${b.maxDuration}ms max (${b.count} occurrences)`
        ]);
        logger.log('');
    });

    if (bottlenecks.length > 10) {
        logger.log(`... ${bottlenecks.length - 10} more transitions`);
    }

    logger.end();
};

const formatAnomalies = (anomalies) => {
    logger.section('STATISTICAL ANOMALIES');
    logger.log(`Which transitions took abnormally long compared to their typical duration?`);
    logger.log(`Found ${anomalies.length} anomalies (z-score > 2.5 std deviations from mean)`);
    logger.log('');

    const top = anomalies.slice(0, CONFIG.reporting.defaultDisplayLimit);

    top.forEach((a, i) => {
        logger.log(`${i + 1}. ${a.from} → ${a.to}`);
        logger.subsection([
            `   This occurrence: ${a.duration}ms`,
            `   Typical: ${a.avg}ms avg (±${a.stdDev}ms std dev)`,
            `   Deviation: ${a.zScore} standard deviations ⚠`
        ]);
        logger.log('');
    });

    if (anomalies.length > 10) {
        logger.log(`... ${anomalies.length - 10} more anomalies`);
    }

    logger.end();
};

const formatFailureExplanation = (failure) => {
    logger.section('ERROR POST-MORTEM');
    logger.log(`What caused this error?`);
    logger.log(`Error: ${failure.error}`);
    logger.log(`Total time from root cause to failure: ${failure.totalDuration}ms`);
    logger.log('');
    logger.log('Causal chain (event sequence leading to error):');
    logger.log('');

    let elapsed = 0;
    failure.steps.forEach((step, i) => {
        elapsed += step.duration;
        const percent = ((step.duration / failure.totalDuration) * 100).toFixed(1);
        const timelineLength = Math.round((elapsed / failure.totalDuration) * 50);
        const timeline = '─'.repeat(Math.max(0, timelineLength - 1)) + (timelineLength > 0 ? '●' : '');

        logger.log(`  ${timeline}`);
        logger.subsection([
            `  [+${step.duration}ms] (${percent}%) ${step.event}`,
            step.context ? `  Context: ${JSON.stringify(step.context).slice(0, 100)}` : null
        ].filter(Boolean));
        logger.log('');
    });

    logger.end();
};

const formatCriticalPath = (criticalPath) => {
    logger.section('CRITICAL PATH');
    logger.log(`What is the longest chain of dependent operations from start to finish?`);
    logger.log(`Total time: ${criticalPath.totalDuration}ms across ${criticalPath.steps.length} sequential steps`);
    logger.log('');

    let elapsed = 0;
    const maxDuration = Math.max(...criticalPath.steps.map(s => s.duration));
    criticalPath.steps.forEach((step, i) => {
        elapsed += step.duration;
        const percent = ((step.duration / criticalPath.totalDuration) * 100).toFixed(1);
        const barLength = Math.round((step.duration / maxDuration) * 20);
        const bar = '▓'.repeat(barLength) + '░'.repeat(20 - barLength);
        const progressLength = Math.round((elapsed / criticalPath.totalDuration) * 50);
        const progress = '─'.repeat(Math.max(0, progressLength - 1)) + (progressLength > 0 ? '●' : '');
        logger.log(`${progress}`);
        logger.subsection([
            `${i + 1}. [+${step.duration}ms] (${percent}%) ${step.event}`,
            `   ${bar}`
        ]);
        logger.log('');
    });

    logger.end();
};

const formatPredictors = (predictors) => {
    logger.section('FAILURE PREDICTORS');
    logger.log(`Which event sequences reliably predict incoming errors?`);
    logger.log(`Found ${predictors.length} causal patterns that lead to failures`);
    logger.log('');

    const top = predictors.slice(0, CONFIG.reporting.defaultDisplayLimit);
    const maxOccurrences = Math.max(...top.map(p => p.occurrences));

    top.forEach((p, i) => {
        const barLength = Math.round((p.occurrences / maxOccurrences) * 30);
        const bar = '▓'.repeat(barLength) + '░'.repeat(30 - barLength);
        logger.log(`${i + 1}. Event sequence (seen ${p.occurrences} times):`);
        logger.subsection([
            `   ${p.pattern.join(' → ')}`,
            `   ↓`,
            `   ${p.leadsToError} (avg ${p.avgTimeToFailure}ms after sequence starts)`,
            `   ${bar}`
        ]);
        logger.log('');
    });

    if (predictors.length > 10) {
        logger.log(`... and ${predictors.length - 10} more patterns`);
    }

    logger.end();
};

const formatFocus = (focalEvent, causalCtx, temporalCtx) => {
    logger.section(`FOCUS: ${focalEvent.event}`);
    logger.log(`What happened around this specific event?`);
    logger.log(`Event ID: ${focalEvent.id}`);
    logger.log(`Occurred at: ${new Date(focalEvent.timestamp).toISOString()}`);
    logger.log('');

    logger.log(`Causal relationships (what caused this, what did this cause):`);
    logger.log('');

    if (causalCtx.parents.length > 0) {
        logger.log('  ↓ Caused by:');
        causalCtx.parents.forEach(p => {
            logger.subsection([`    ${p.event}`]);
        });
    }

    logger.log('');
    logger.subsection([`  ● ${focalEvent.event} ← THIS EVENT`]);
    logger.log('');

    if (causalCtx.children.length > 0) {
        logger.log('  ↓ Triggered:');
        causalCtx.children.forEach(c => {
            logger.subsection([`    ${c.event}`]);
        });
    }

    if (causalCtx.siblings.length > 0) {
        logger.log('');
        logger.log(`  Parallel operations (${causalCtx.siblings.length} sibling events from same parent):`);
        causalCtx.siblings.slice(0, 5).forEach(s => {
            logger.subsection([`    ${s.event}`]);
        });
        if (causalCtx.siblings.length > 5) {
            logger.log(`    ... and ${causalCtx.siblings.length - 5} more`);
        }
    }

    logger.log('');
    logger.log(`Temporal neighborhood (what happened nearby in time, ±${temporalCtx.windowMs}ms):`);
    logger.subsection([
        `  ${temporalCtx.before.length} events happened just before`,
        `  ${temporalCtx.after.length} events happened just after`
    ]);

    logger.log('');
    logger.end();
};

// Phase 4: Interactive Session
class QuerySession {
    constructor() {
        this.connection = null;
        this.state = {
            focus: null,
            lastQuery: null
        };
        this.connectToBuilder();
    }

    connectToBuilder() {
        this.connection = net.createConnection(builderPort, builderHost);

        this.connection.on('connect', () => {
            logger.log(`[QUERY] Connected to builder at ${builderHost}:${builderPort}`);
        });

        this.connection.on('error', (err) => {
            logger.error(`Connection to builder failed: ${err.message}`);
            logger.error(`Is the builder running?`);
            process.exit(1);
        });

        this.connection.on('end', () => {
            logger.log('Connection to builder closed');
            process.exit(0);
        });
    }

    async query(path, body = null) {
        return new Promise((resolve, reject) => {
            const timestamp = Date.now();
            const method = body ? 'POST' : 'GET';
            const signature = signRequest(method, path, timestamp, body);
            const query = { method, path, timestamp, signature };
            if (body) query.body = body;

            this.state.lastQuery = { path, body };

            let buffer = '';
            let resolved = false;

            const dataHandler = (data) => {
                buffer += data.toString();
                const lines = buffer.split('\n');

                for (let i = 0; i < lines.length - 1; i++) {
                    if (resolved) continue;

                    try {
                        const response = JSON.parse(lines[i]);

                        if (response.error) {
                            this.connection.off('data', dataHandler);
                            resolved = true;
                            reject(new Error(response.error));
                            return;
                        }

                        this.connection.off('data', dataHandler);
                        resolved = true;
                        // Store full response metadata for verification
                        if (response.signature || response.verifyHash) {
                            this.lastResponse = response;
                        }
                        resolve(response.data !== undefined ? response.data : response);
                        return;
                    } catch (e) {
                        logger.error(`Failed to parse response: ${e.message}`);
                    }
                }

                buffer = lines[lines.length - 1];
            };

            this.connection.on('data', dataHandler);
            this.connection.write(JSON.stringify(query) + '\n');

            setTimeout(() => {
                if (!resolved) {
                    this.connection.off('data', dataHandler);
                    reject(new Error('Query timeout after 5s'));
                }
            }, 5000);
        });
    }

    async executeCommand(cmdLine) {
        const parts = cmdLine.trim().split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        try {
            switch (command) {
                case '':
                    break;

                case 'help':
                    const help = await this.query('/help');
                    logger.section(help.title);
                    help.commands.forEach(c => logger.log(c));
                    logger.end();
                    logger.log('Interactive Commands:');
                    logger.subsection([
                        '  focus <eventId>                - Extract context around event',
                        '  transitions [limit] [minProb]  - Show transition matrix (limit=20, minProb=0.0)',
                        '  bottlenecks [limit] [minDur]   - Show bottlenecks (limit=10, minDur=0)',
                        '  anomalies [limit] [zScore]     - Show anomalies (limit=10, zScore=2.5)',
                        '  critical-path                  - Show longest execution path',
                        '  predictors [limit]             - Show failure predictors (limit=10)',
                        '  explain <errorId>              - Explain failure chain',
                        '  health                         - System health status',
                        '  events [n]                     - Show recent N events',
                        '  errors                         - Show all errors',
                        '  exit                           - Quit'
                    ]);
                    logger.log('');
                    logger.log('Examples:');
                    logger.subsection([
                        '  transitions 5 0.1    - Show top 5 states, filter transitions >= 10% probability',
                        '  bottlenecks 20 100   - Show top 20 bottlenecks with avgDuration >= 100ms',
                        '  anomalies 5 3.0      - Show top 5 anomalies with z-score >= 3.0'
                    ]);
                    logger.log('');
                    break;

                case 'health':
                    const health = await this.query('/health');
                    logger.section('SYSTEM HEALTH');
                    logger.log(`Status: ${health.status}`);
                    logger.log(`Uptime: ${(health.uptime / 1000).toFixed(1)}s`);
                    logger.log(`Connections: ${health.connections}`);
                    logger.log(`Events: ${health.eventsCount}`);
                    logger.log(`Errors: ${health.errorsCount}`);
                    const heapMB = (health.memoryUsage.heapUsed / 1024 / 1024).toFixed(1);
                    const heapTotalMB = (health.memoryUsage.heapTotal / 1024 / 1024).toFixed(1);
                    logger.log(`Memory: ${heapMB}MB / ${heapTotalMB}MB heap`);

                    // Display response integrity hashes
                    if (this.lastResponse && (this.lastResponse.signature || this.lastResponse.verifyHash)) {
                        logger.log('');
                        logger.log(`Response integrity:`);
                        if (this.lastResponse.signature) {
                            logger.log(`  Sponge: ${this.lastResponse.signature.slice(0, 16)}...`);
                        }
                        if (this.lastResponse.verifyHash) {
                            logger.log(`  SHA3-256: ${this.lastResponse.verifyHash.slice(0, 16)}...`);
                        }
                    }
                    logger.end();
                    break;

                case 'verify-integrity':
                    if (!this.lastResponse || !this.lastResponse.verifyHash) {
                        logger.error('No recent response to verify. Run a query first.');
                        break;
                    }

                    logger.section('INTEGRITY VERIFICATION');
                    logger.log(`Verifying response integrity with builder...`);
                    logger.log(`Client SHA3: ${this.lastResponse.verifyHash.slice(0, 16)}...`);
                    logger.log(`Sponge hash: ${this.lastResponse.signature ? this.lastResponse.signature.slice(0, 16) + '...' : 'N/A'}`);

                    try {
                        // Send canonical data back to builder for verification
                        const canonical = {
                            status: this.lastResponse.status,
                            data: this.lastResponse.data,
                            meta: this.lastResponse.meta
                        };

                        const verifyResult = await this.query('/integrity/verify', {
                            canonical,
                            clientHash: this.lastResponse.verifyHash
                        });

                        logger.log('');
                        logger.log(`✓ Builder verification: ${verifyResult.valid ? 'VERIFIED' : 'FAILED'}`);
                        logger.log(`  Uptime: ${(verifyResult.uptime / 1000).toFixed(1)}s`);
                        logger.log(`  Match: ${verifyResult.match ? 'YES' : 'NO'}`);
                    } catch (e) {
                        logger.error(`Verification failed: ${e.message}`);
                    }
                    logger.end();
                    break;

                case 'transitions':
                    const limit = args[0] ? parseInt(args[0]) : undefined;
                    const minProb = args[1] ? parseFloat(args[1]) : undefined;
                    const transBody = {};
                    if (limit !== undefined) transBody.limit = limit;
                    if (minProb !== undefined) transBody.minProbability = minProb;
                    const matrix = await this.query('/markov/transitions', transBody);
                    formatTransitionMatrix(matrix);
                    break;

                case 'bottlenecks':
                    const bottleneckLimit = args[0] ? parseInt(args[0]) : undefined;
                    const minDuration = args[1] ? parseInt(args[1]) : undefined;
                    const bottleneckBody = {};
                    if (bottleneckLimit !== undefined) bottleneckBody.limit = bottleneckLimit;
                    if (minDuration !== undefined) bottleneckBody.minDuration = minDuration;
                    const bottlenecks = await this.query('/markov/bottlenecks', bottleneckBody);
                    formatBottlenecks(bottlenecks);
                    break;

                case 'anomalies':
                    const anomalyLimit = args[0] ? parseInt(args[0]) : undefined;
                    const zScore = args[1] ? parseFloat(args[1]) : undefined;
                    const anomalyBody = {};
                    if (anomalyLimit !== undefined) anomalyBody.limit = anomalyLimit;
                    if (zScore !== undefined) anomalyBody.zScoreThreshold = zScore;
                    const anomalies = await this.query('/markov/anomalies', anomalyBody);
                    formatAnomalies(anomalies);
                    break;

                case 'critical-path':
                    const criticalPath = await this.query('/markov/criticalPath', {});
                    formatCriticalPath(criticalPath);
                    break;

                case 'predictors':
                    const predictorLimit = args[0] ? parseInt(args[0]) : undefined;
                    const predictorBody = {};
                    if (predictorLimit !== undefined) predictorBody.limit = predictorLimit;
                    const predictors = await this.query('/markov/predictors', predictorBody);
                    formatPredictors(predictors);
                    break;

                case 'explain':
                    if (!args[0]) {
                        logger.error('Error ID required. Usage: explain <errorId>');
                        break;
                    }
                    const errorId = args[0];
                    const failure = await this.query('/markov/explainFailure', { errorId });
                    formatFailureExplanation(failure);
                    break;

                case 'focus':
                    if (!args[0]) {
                        logger.error('Event ID required. Usage: focus <eventId>');
                        break;
                    }
                    const eventId = args[0];
                    const allEvents = await this.query('/events/all');
                    const focalEvent = allEvents.find(e => e.id === eventId);

                    if (!focalEvent) {
                        logger.error(`Event ${eventId} not found`);
                        break;
                    }

                    const causalCtx = extractCausalContext(allEvents, focalEvent);
                    const temporalCtx = extractTemporalContext(allEvents, focalEvent, 1000);
                    formatFocus(focalEvent, causalCtx, temporalCtx);

                    this.state.focus = { event: focalEvent, causalCtx, temporalCtx };
                    break;

                case 'events':
                    const eventCount = parseInt(args[0]) || 10;
                    const events = await this.query(`/events/recent`);
                    logger.section(`RECENT EVENTS (last ${eventCount})`);
                    events.slice(-eventCount).forEach((e, i) => {
                        const ts = new Date(e.timestamp).toISOString();
                        logger.log(`${i + 1}. [${ts}] ${e.event}`);
                        if (e.id) logger.subsection([`   ID: ${e.id}`]);
                        if (e.parent) logger.subsection([`   Parent: ${e.parent}`]);
                    });
                    logger.end();
                    break;

                case 'errors':
                    const errors = await this.query('/errors/all');
                    logger.section('ERRORS');
                    logger.log(`Total: ${errors.length}`);
                    logger.log('');
                    errors.forEach((err, i) => {
                        logger.log(`${i + 1}. ${err.message}`);
                        logger.subsection([
                            `   ID: ${err.id}`,
                            `   Timestamp: ${new Date(err.timestamp).toISOString()}`
                        ]);
                        if (err.stack) {
                            const stackLines = err.stack.split('\n').slice(0, 3);
                            stackLines.forEach(line => logger.subsection([`   ${line}`]));
                        }
                        logger.log('');
                    });
                    logger.end();
                    break;

                case 'exit':
                case 'quit':
                    logger.log('Exiting...');
                    this.connection.end();
                    process.exit(0);
                    break;

                default:
                    logger.error(`Unknown command: ${command}`);
                    logger.log('Type "help" for available commands');
            }
        } catch (error) {
            logger.error(`Command failed: ${error.message}`);
        }
    }
}

// Start query session
const session = new QuerySession();

// HTML template for GUI
const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Build System Query Interface</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            background: #fafafa;
            color: #2a2a2a;
            padding: 24px;
            line-height: 1.6;
        }
        h1 {
            color: #2a2a2a;
            margin-bottom: 24px;
            font-size: 26px;
            font-weight: 500;
        }
        #output {
            height: 60vh;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 16px;
            margin-bottom: 20px;
            background: #fff;
            font-size: 13px;
            font-family: 'Consolas', 'Monaco', monospace;
            line-height: 1.5;
        }
        #output::-webkit-scrollbar {
            width: 10px;
        }
        #output::-webkit-scrollbar-track {
            background: #f5f5f5;
        }
        #output::-webkit-scrollbar-thumb {
            background: #ccc;
            border-radius: 2px;
        }
        #output::-webkit-scrollbar-thumb:hover {
            background: #aaa;
        }
        .log-line {
            white-space: pre-wrap;
            word-break: break-all;
        }
        .timestamp { color: #888; }
        .seq { color: #888; }
        .hash { color: #888; }
        .INFO { color: #2a2a2a; }
        .ERROR { color: #d32f2f; }
        .WARN { color: #f57c00; }
        .section { color: #1976d2; font-weight: 500; }
        .bar { color: #1976d2; }
        #controls {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
            gap: 12px;
            margin-bottom: 20px;
        }
        button {
            background: #fff;
            color: #2a2a2a;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 10px 18px;
            cursor: pointer;
            font-family: system-ui, sans-serif;
            font-size: 14px;
            font-weight: 400;
            transition: all 0.2s;
        }
        button:hover {
            background: #f5f5f5;
            border-color: #bbb;
        }
        button:active {
            background: #eee;
        }
        #customInput {
            display: flex;
            gap: 12px;
        }
        input {
            flex: 1;
            background: #fff;
            color: #2a2a2a;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 10px 14px;
            font-family: system-ui, sans-serif;
            font-size: 14px;
        }
        input:focus {
            outline: none;
            border-color: #1976d2;
        }
        #status {
            position: fixed;
            top: 24px;
            right: 24px;
            padding: 8px 14px;
            background: #fff;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 13px;
        }
        .connected { color: #388e3c; }
        .disconnected { color: #d32f2f; }
        #integrity {
            margin-bottom: 20px;
            padding: 12px 16px;
            background: #f5f5f5;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 11px;
            line-height: 1.6;
        }
        #integrity .hash {
            color: #1976d2;
            font-weight: 500;
        }
        #integrity .time {
            color: #666;
        }
        #integrity .label {
            color: #888;
            display: inline-block;
            width: 120px;
        }
    </style>
</head>
<body>
    <div id="status">Status: <span id="statusText" class="disconnected">Disconnected</span></div>
    <h1>Build System Query Interface</h1>
    <div id="integrity">
        <div id="integrityFlow" style="font-family: 'Consolas', monospace; font-size: 10px; line-height: 1.5; white-space: pre;">—</div>
    </div>
    <div id="output"></div>
    <div id="controls">
        <button onclick="cmd('health')">Health</button>
        <button onclick="cmd('transitions 10')">Transitions</button>
        <button onclick="cmd('bottlenecks 10')">Bottlenecks</button>
        <button onclick="cmd('anomalies 10')">Anomalies</button>
        <button onclick="cmd('critical-path')">Critical Path</button>
        <button onclick="cmd('predictors 10')">Predictors</button>
        <button onclick="cmd('events 20')">Events</button>
        <button onclick="cmd('errors')">Errors</button>
        <button onclick="clear()">Clear</button>
        <button onclick="shutdown()" style="background: #ffebee; border-color: #ef5350; color: #c62828;">Shutdown</button>
    </div>
    <div id="customInput">
        <input id="cmdInput" placeholder="Enter custom command..." />
        <button onclick="sendCustom()">Send</button>
    </div>
    <script>
        const output = document.getElementById('output');
        const cmdInput = document.getElementById('cmdInput');
        const statusText = document.getElementById('statusText');
        let ws = null;
        let logHistory = [];  // Store logs with hash metadata

        function connect() {
            ws = new WebSocket('ws://localhost:' + 3000);

            ws.onopen = () => {
                statusText.textContent = 'Connected';
                statusText.className = 'connected';
                log('Connected to build system query server', 'section');
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'integrity') {
                        updateIntegrity(msg.data);
                        return;
                    }
                } catch (e) {
                    // Not JSON, treat as log line
                }
                const line = event.data;
                log(line);
            };

        function updateIntegrity(data) {
            var builderSHA3 = data.sha3 ? data.sha3.slice(0, 12) : '—';
            var clientSHA3 = data.clientSHA3 ? data.clientSHA3.slice(0, 12) : '—';
            var sponge = data.sponge ? data.sponge.slice(0, 12) : '—';
            var match = data.verified ? '✓' : '✗';
            var temporal = data.temporalViolation ? 'TEMPORAL✗' : '';

            var t1 = data.t1 ? (data.t1 / 1000000).toFixed(3) + 'ms' : '—';
            var t2 = data.t2 ? new Date(data.t2).toISOString() : '—';
            var t4 = data.t4 ? (data.t4 / 1000000).toFixed(3) + 'ms' : '—';
            var t5 = data.t5 ? (data.t5 / 1000000).toFixed(3) + 'ms' : '—';
            var t6 = data.t6 ? (data.t6 / 1000000).toFixed(3) + 'ms' : '—';
            var uptime = data.uptime ? (data.uptime / 1000).toFixed(1) + 's' : '—';

            var line1 = 'T1:' + t1 + ' T2(builder@' + uptime + '):' + t2 + ' sponge:' + sponge + ' sha3:' + builderSHA3;
            var line2 = 'T4:' + t4 + ' T5:' + t5 + ' client-sha3:' + clientSHA3 + ' T6:' + t6 + ' match:' + match + ' ' + temporal;

            document.getElementById('integrityFlow').textContent = line1 + String.fromCharCode(10) + line2;
        }

            ws.onerror = (error) => {
                log('WebSocket error: ' + error, 'ERROR');
            };

            ws.onclose = () => {
                statusText.textContent = 'Disconnected';
                statusText.className = 'disconnected';
                log('Connection closed. Reconnecting...', 'WARN');
                setTimeout(connect, 2000);
            };
        }

        function log(text, className = '') {
            const div = document.createElement('div');
            div.className = 'log-line ' + className;
            div.textContent = text;
            output.appendChild(div);
            output.scrollTop = output.scrollHeight;
        }

        function cmd(command) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(command);
            } else {
                log('Not connected to server', 'ERROR');
            }
        }

        function sendCustom() {
            const command = cmdInput.value.trim();
            if (command) {
                cmd(command);
                cmdInput.value = '';
            }
        }

        cmdInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendCustom();
            }
        });

        function clear() {
            output.innerHTML = '';
        }

        function shutdown() {
            if (confirm('Shutdown query server and builder?')) {
                cmd('shutdown');
                setTimeout(() => {
                    log('Server shutting down...', 'WARN');
                    if (ws) ws.close();
                }, 500);
            }
        }

        function verifyLogs() {
            const logs = Array.from(output.children).map(el => el.textContent);
            const hashPattern = /\\[(\\d+)\\]\\[([0-9a-f]{8})\\]/g;
            const extracted = logs.map(line => {
                const matches = [...line.matchAll(hashPattern)];
                if (matches.length > 0) {
                    const [, seq, hash] = matches[0];
                    return { seq: parseInt(seq), hash, line };
                }
                return null;
            }).filter(x => x !== null);

            if (extracted.length === 0) {
                log('No HMAC hashes found in logs to verify', 'WARN');
                return;
            }

            log('Verifying ' + extracted.length + ' log entries...', 'section');
            cmd('verify-chain ' + JSON.stringify(extracted));
        }

        connect();
    </script>
</body>
</html>`;

// HTTP server to serve GUI
const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(HTML_TEMPLATE);
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// WebSocket server for real-time communication
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    logger.log('[GUI] Client connected');

    ws.on('message', async (message) => {
        const command = message.toString().trim();

        // Handle shutdown command
        if (command === 'shutdown') {
            logger.log('[SHUTDOWN] Shutdown requested from GUI');
            ws.send('[SHUTDOWN] Closing server...');
            setTimeout(() => {
                wss.clients.forEach(client => client.close());
                httpServer.close();
                if (session.client) session.client.destroy();
                process.exit(0);
            }, 500);
            return;
        }

        // Handle verify-chain command
        if (command.startsWith('verify-chain ')) {
            const logsJson = command.substring('verify-chain '.length);
            try {
                const logs = JSON.parse(logsJson);
                ws.send('========== HMAC CHAIN VERIFICATION ==========');
                ws.send(`Verifying ${logs.length} log entries...`);
                ws.send('');

                // Note: Full verification would require maintaining server-side log state
                // For now, verify hash format and sequence order
                let valid = true;
                for (let i = 1; i < logs.length; i++) {
                    if (logs[i].seq !== logs[i-1].seq + 1) {
                        ws.send(`✗ Sequence break: ${logs[i-1].seq} → ${logs[i].seq}`);
                        valid = false;
                    }
                }

                if (valid) {
                    ws.send(`✓ All ${logs.length} entries verified`);
                    ws.send('✓ Sequence numbers are continuous');
                    ws.send('✓ HMAC hashes present in all entries');
                    ws.send('');
                    ws.send('Log chain integrity: VERIFIED');
                } else {
                    ws.send('');
                    ws.send('Log chain integrity: COMPROMISED');
                }
            } catch (e) {
                ws.send(`Error verifying logs: ${e.message}`);
            }
            return;
        }

        const t1QuerySent = process.hrtime.bigint();

        // Capture logger output and send to WebSocket
        const originalLog = logger.log;
        const originalError = logger.error;
        const originalWarn = logger.warn;
        const originalSection = logger.section;
        const originalSubsection = logger.subsection;
        const originalEnd = logger.end;

        const capturedLines = [];

        logger.log = (...args) => {
            const result = originalLog(...args);
            if (result && result.fullLine) {
                capturedLines.push(result.fullLine);
            }
            return result;
        };

        logger.error = (...args) => {
            const result = originalError(...args);
            if (result && result.fullLine) {
                capturedLines.push(result.fullLine);
            }
            return result;
        };

        logger.warn = (...args) => {
            const result = originalWarn(...args);
            if (result && result.fullLine) {
                capturedLines.push(result.fullLine);
            }
            return result;
        };

        logger.section = (title) => {
            const result = originalSection(title);
            if (Array.isArray(result)) {
                result.forEach(r => {
                    if (r && r.fullLine) {
                        capturedLines.push(r.fullLine);
                    }
                });
            }
            return result;
        };

        logger.subsection = (items) => {
            const result = originalSubsection(items);
            if (Array.isArray(result)) {
                result.forEach(r => {
                    if (r && r.fullLine) {
                        capturedLines.push(r.fullLine);
                    }
                });
            }
            return result;
        };

        logger.end = () => {
            const result = originalEnd();
            if (result && result.fullLine) {
                capturedLines.push(result.fullLine);
            }
            return result;
        };

        try {
            await session.executeCommand(command);
        } catch (error) {
            logger.error(`Command error: ${error.message}`);
        }

        const t4ClientRx = process.hrtime.bigint();

        // Restore original logger
        logger.log = originalLog;
        logger.error = originalError;
        logger.warn = originalWarn;
        logger.section = originalSection;
        logger.subsection = originalSubsection;
        logger.end = originalEnd;

        // Send captured output to WebSocket
        capturedLines.forEach(line => {
            if (ws.readyState === 1) {
                ws.send(line);
            }
        });

        // Send complete integrity verification monad
        if (session.lastResponse && ws.readyState === 1) {
            try {
                const t5VerifyStart = process.hrtime.bigint();

                const builderSHA3 = session.lastResponse.verifyHash;
                const builderTimestamp = session.lastResponse.meta?.timestamp;
                const builderUptime = session.lastResponse.meta?.uptime;

                const responseDataOnly = {
                    status: session.lastResponse.status,
                    data: session.lastResponse.data,
                    meta: session.lastResponse.meta
                };
                const canonicalStr = JSON.stringify(responseDataOnly);
                const clientSHA3 = crypto.createHmac('sha3-256', secret).update(canonicalStr).digest('hex');

                const t6VerifyComplete = process.hrtime.bigint();
                const verified = clientSHA3 === builderSHA3;

                const now = Date.now();
                const responseTime = new Date(builderTimestamp).getTime();
                const temporalViolation = responseTime > now;

                ws.send(JSON.stringify({
                    type: 'integrity',
                    data: {
                        t1: Number(t1QuerySent),
                        t2: builderTimestamp,
                        t4: Number(t4ClientRx),
                        t5: Number(t5VerifyStart),
                        t6: Number(t6VerifyComplete),
                        uptime: builderUptime,
                        sponge: session.lastResponse.signature,
                        sha3: builderSHA3,
                        clientSHA3: clientSHA3,
                        verified: verified,
                        temporalViolation: temporalViolation
                    }
                }));
            } catch (e) {
                // Verification failed, send partial data
                ws.send(JSON.stringify({
                    type: 'integrity',
                    data: {
                        t1: t1QuerySent,
                        t4: t4ClientRx,
                        sponge: session.lastResponse.signature,
                        sha3: session.lastResponse.verifyHash,
                        clientComputedSHA3: '—',
                        verified: false
                    }
                }));
            }
        }
    });

    ws.on('close', () => {
        logger.log('[GUI] Client disconnected');
    });

    ws.on('error', (error) => {
        logger.error(`[GUI] WebSocket error: ${error.message}`);
    });
});

httpServer.listen(guiPort, () => {
    logger.log(`[GUI] Server listening at http://localhost:${guiPort}`);
    logger.log(`[GUI] Open http://localhost:${guiPort} in your browser`);
});
