import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { execSync } from 'child_process';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function loadOrGenerateSecret() {
    const p = path.join(os.homedir(), '.builder-trace-secret');
    const len = 32;
    const enc = 'hex';

    if (process.env.BUILDER_TRACE_SECRET?.length === len * 2)
        return Buffer.from(process.env.BUILDER_TRACE_SECRET, enc);

    try {
        const hex = fs.readFileSync(p, 'utf8').trim();
        if (hex.length === len * 2) return Buffer.from(hex, enc);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new Error(`Failed to read trace secret from ${p}: ${e.message}`);
        }
    }

    const s = crypto.randomBytes(len);
    try {
        fs.writeFileSync(p, s.toString(enc), { mode: 0o600 });
    } catch (e) {
        throw new Error(`Failed to write trace secret to ${p}: ${e.message}`);
    }
    return s;
}

const HMAC_KEY = loadOrGenerateSecret();

const logger = (() => {
    let logSequence = 0;
    let lastLogHash = null;

    const writeLog = (level, ...args) => {
        const timestamp = Date.now();
        const seq = logSequence++;
        const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');

        const hmac = crypto.createHmac('sha256', HMAC_KEY);
        if (lastLogHash) hmac.update(lastLogHash);
        hmac.update(`${timestamp}|${seq}|${level}|${message}`);
        const hash = hmac.digest('hex');
        lastLogHash = hash;

        const prefix = `[${new Date(timestamp).toISOString()}][${seq}][${hash.slice(0, 8)}][${level}]`;
        const output = level === 'ERROR' || level === 'WARN' ? console.error : console.log;
        output(prefix, ...args);

        return hash;
    };

    return {
        log: (...args) => writeLog('INFO', ...args),
        error: (...args) => writeLog('ERROR', ...args),
        warn: (...args) => writeLog('WARN', ...args)
    };
})();

let traceOrchestrator;
let queryServer;
let configPatternValidator;
let hasher;

// Lazy evaluation wrapper

class Lazy {
    constructor(thunk) {
        this._thunk = thunk;
        this._cache = undefined;
        this._evaluated = false;
    }

    get value() {
        if (pullGraph) {
            pullGraph.totalPulls++;
        }

        if (!this._evaluated) {
            if (pullGraph) {
                pullGraph.pullCount++;
            }

            try {
                this._cache = this._thunk();
                this._evaluated = true;

                if (traceOrchestrator) {
                    if (typeof this._cache === 'string' && (this._cache.includes('/') || this._cache.includes('\\'))) {
                        traceOrchestrator.trace('LAZY_PATH', { path: this._cache, thunk: this._thunk.name });
                    }
                }
            } catch (error) {
                this._evaluated = true;
                this._cache = { error };
                throw error;
            } finally {
                this._thunk = null;
            }
        } else {
            if (pullGraph) {
                pullGraph.cacheHits++;
            }
        }

        if (this._cache && this._cache.error) {
            throw this._cache.error;
        }
        return this._cache;
    }
    
   
    force() {
        return this.value;
    }
    
   
    map(f) {
        return new Lazy(() => f(this.value));
    }
    
   
    flatMap(f) {
        return new Lazy(() => {
            const result = f(this.value);
            return result instanceof Lazy ? result.value : result;
        });
    }
    
    isEvaluated() {
        return this._evaluated;
    }
    
   
    toString() {
        return String(this.value);
    }
    
   
    valueOf() {
        return this.value;
    }
}

// Lazy template that only evaluates when converted to string
class LazyTemplate {
    constructor(parts) {
        this.parts = parts;
        this._cache = undefined;
        this._evaluated = false;
    }

    toString() {
        if (!this._evaluated) {
            try {
                this._cache = this.parts.map(part => {
                    if (part instanceof Lazy) {
                        return part.toString();
                    } else if (part instanceof LazyTemplate) {
                        return part.toString();
                    } else if (part && typeof part === 'object' && part.value !== undefined) {
                        return String(pull(part));
                    }
                    return String(part);
                }).join('');
                this._evaluated = true;
            } catch (error) {
                this._evaluated = true;
                this._cache = { error };
                throw error;
            } finally {
                this.parts = null;
            }
        }
        if (this._cache && this._cache.error) {
            throw this._cache.error;
        }
        return this._cache;
    }
}

// Utilities for mapping and extracting from lazy structures
class LazyFunctor {
    static map(f, lazyStructure) {
        if (lazyStructure instanceof Lazy) {
            return lazyStructure.map(f);
        }
        if (typeof lazyStructure === 'object' && lazyStructure !== null) {
            const result = {};
            for (const [k, v] of Object.entries(lazyStructure)) {
                result[k] = LazyFunctor.map(f, v);
            }
            return result;
        }
        return f(lazyStructure);
    }

   
    static extract(lazyStructure) {
        return LazyFunctor.map(x => x instanceof Lazy ? x.value : x, lazyStructure);
    }

   
    static lift(value) {
        if (value instanceof Lazy) return value;
        return new Lazy(() => value);
    }
}

class Pipeline {
   
    static kleisli(...stages) {
        if (stages.length === 0) return x => LazyFunctor.lift(x);
        if (stages.length === 1) return stages[0];
        
        return stages.reduce((f, g) => {
            return (x) => {
                const fx = f(x);
                if (fx instanceof Lazy) {
                    return fx.flatMap(g);
                } else if (fx instanceof PullPromise) {
                    return new PullPromise(async () => {
                        const result = await fx.pull();
                        const gx = g(result);
                        if (gx instanceof PullPromise) {
                            return await gx.pull();
                        } else if (gx instanceof Lazy) {
                            return gx.value;
                        }
                        return gx;
                    });
                }
                return g(fx);
            };
        });
    }
    
   
    static compose(...stages) {
        return Pipeline.kleisli(...stages);
    }
    
   
    static withCache(cacheKey, pipeline) {
        return new PullPromise(async () => {
           
            const cached = pullGraph.objects.get(cacheKey);
            if (cached && cached.cached && cached.value) {
                traceOrchestrator.trace('PIPELINE_CACHE_HIT', { cacheKey });
                return cached.value;
            }
            
           
            const result = await (pipeline instanceof PullPromise ? pipeline.pull() : pipeline);
            
           
            if (result) {
                pullGraph.register(cacheKey, new Lazy(() => result));
                traceOrchestrator.trace('PIPELINE_CACHE_STORE', { cacheKey });
            }
            
            return result;
        });
    }
    
}

// Configuration with environment access
class ConfigContext {
    constructor(value, environment) {
        this.value = value;
        this.environment = environment instanceof Lazy ? environment : new Lazy(() => environment);
    }

   
    extract() {
        return this.value;
    }

   
    extend(f) {
        return new ConfigContext(
            f(this),
            this.environment
        );
    }
    
   
    asks(f) {
        return new Lazy(() => f(this.environment.value));
    }
    
   
    static create() {
        return new ConfigContext(null, {
            time: TIME,
            limits: LIMITS,
            config: CONFIG,
           
        });
    }
    
   
    derive(computation) {
        return this.extend(ctx =>
            new Lazy(() => computation(ctx.environment.value))
        );
    }
}

// Lazy streams - head evaluated immediately, tail computed on access
class LazyStream {
    constructor(head, tailThunk) {
        this.head = head;
        this._tailThunk = tailThunk;
        this._tail = null;
        this._error = null;
    }

    get tail() {
        if (this._tail === null && this._tailThunk) {
            try {
                this._tail = this._tailThunk();
            } catch (error) {
                this._error = error;
                this._tailThunk = null;
                throw error;
            }
            this._tailThunk = null;
        }
        if (this._error) {
            throw this._error;
        }
        return this._tail;
    }
    
    take(n) {
        const result = [];
        let current = this;
        for (let i = 0; i < n && current; i++) {
            result.push(current.head);
            current = current.tail;
        }
        return result;
    }
    
    map(f) {
        return new LazyStream(
            f(this.head),
            this._tailThunk ? () => this.tail.map(f) : null
        );
    }
    
   
    cons(element) {
        return new LazyStream(element, () => this);
    }
    
   
    append(element) {
        if (!this._tailThunk) {
           
            return new LazyStream(
                this.head,
                () => new LazyStream(element, null)
            );
        }
       
        return new LazyStream(
            this.head,
            () => this.tail.append(element)
        );
    }
    
   
    concat(other) {
        if (!this._tailThunk) {
            return new LazyStream(this.head, () => other);
        }
        return new LazyStream(
            this.head,
            () => this.tail.concat(other)
        );
    }
    
   
    static empty() {
        return null;
    }
    
   
    static fromArray(arr) {
        if (arr.length === 0) return null;
        return new LazyStream(
            arr[0],
            arr.length > 1 ? () => LazyStream.fromArray(arr.slice(1)) : null
        );
    }
    
    filter(pred) {
        if (pred(this.head)) {
            return new LazyStream(
                this.head,
                this._tailThunk ? () => this.tail.filter(pred) : null
            );
        }
        return this.tail ? this.tail.filter(pred) : null;
    }
    
    window(n) {
        if (n <= 0 || !this._tailThunk) return null;
        
        const buffer = [];
        let current = this;
        for (let i = 0; i < n && current; i++) {
            buffer.push(current.head);
            current = current.tail;
        }
        
        if (buffer.length < n) return null;
        
        return new LazyStream(
            buffer,
            this.tail ? () => this.tail.window(n) : null
        );
    }
}



// Lazy proxy for automatic lazification of any object
const lazify = (obj) => {
    const cache = new Map();
    
    return new Proxy(obj, {
        get(target, prop) {
            if (!cache.has(prop)) {
                const value = target[prop];
                if (typeof value === 'function') {
                   
                    cache.set(prop, (...args) => {
                        const key = JSON.stringify(args);
                        if (!cache.has(`${prop}_${key}`)) {
                            cache.set(`${prop}_${key}`, new Lazy(() => value(...args)));
                        }
                        return cache.get(`${prop}_${key}`).value;
                    });
                } else if (typeof value === 'object' && value !== null) {
                   
                    cache.set(prop, lazify(value));
                } else {
                   
                    cache.set(prop, new Lazy(() => value));
                }
            }
            const cached = cache.get(prop);
            return cached instanceof Lazy ? cached.value : cached;
        }
    });
};

// Lazy recursive definitions (for coinduction)
const fix = (f) => {
    const lazy = new Lazy(() => f(lazy.value));
    return lazy;
};

// Dependency graph for pull-based computation
class PullGraph {
    constructor() {
       
        this.objects = new Map();

       
        this.morphisms = new Map();

       
        this.identities = new Map();

       
        this.compositions = new Map();

        this.pullCount = 0;
        this.cacheHits = 0;
        this.totalPulls = 0;
        this.errorBoundaries = new Map();
        this.progressCallback = null;
    }

   
    register(id, computation, errorHandler = null) {
        const obj = {
            computation: computation instanceof Lazy ? computation : new Lazy(computation),
            cached: false,
            value: undefined,
            pullCount: 0,
            category: 'pull-graph'
        };
        
        this.objects.set(id, obj);
        
       
        this.identities.set(id, x => x);
        
        if (errorHandler) {
            this.errorBoundaries.set(id, errorHandler);
        }
    }

   
    morphism(sourceId, targetId, transform = x => x) {
        const morphId = `${sourceId}->${targetId}`;
        this.morphisms.set(morphId, {
            source: sourceId,
            target: targetId,
            transform: transform instanceof Lazy ? transform : new Lazy(() => transform),
            category: 'morphism'
        });
        
       
        if (!this.edges) this.edges = new Map();
        if (!this.edges.has(targetId)) {
            this.edges.set(targetId, new Set());
        }
        this.edges.get(targetId).add(sourceId);
    }


   
    compose(f, g) {
        if (f.target !== g.source) {
            throw new Error(`Cannot compose morphisms: ${f.source}->${f.target} and ${g.source}->${g.target}`);
        }

        const composed = {
            source: f.source,
            target: g.target,
            transform: new Lazy(() => {
                const fx = f.transform.value;
                const gx = g.transform.value;
                return x => gx(fx(x));
            }),
            category: 'composed-morphism'
        };

        const compId = `${f.source}->>${g.target}`;
        this.compositions.set(compId, composed);
        return composed;
    }

    dependsOn(nodeId, dependencyId) {
        this.morphism(dependencyId, nodeId);
    }
    
    get nodes() {
        return this.objects;
    }
    
    pull(nodeId, pullPath = []) {
        const node = this.objects.get(nodeId);
        if (!node) {
            const error = new Error(`Unknown object: ${nodeId}`);
            if (traceOrchestrator) traceOrchestrator.error(error, { nodeId, pullPath });
            return { error, value: undefined };
        }

        if (!node.cached) {
            const startTime = performance.now();
            const startMem = process.memoryUsage().heapUsed;

            const currentPath = [...pullPath, nodeId];

            if (this.progressCallback && this.pullCount % CONFIG.processing.progress.pullGraphLogInterval === 0) {
                this.progressCallback({
                    pullCount: this.pullCount,
                    totalPulls: this.totalPulls,
                    cacheHits: this.cacheHits,
                    nodeId,
                    stage: 'dependencies',
                    pullPath: currentPath
                });
            }

            if (traceOrchestrator) {
                traceOrchestrator.trace('PULL_GRAPH_COMPUTE', {
                    nodeId,
                    hasDeps: this.edges?.has(nodeId),
                    pullCount: node.pullCount++,
                    pullPath: currentPath,
                    pullDepth: currentPath.length
                });
            }

            const deps = this.edges?.get(nodeId);
            if (deps) {
                for (const depId of deps) {
                    const depResult = this.pull(depId, currentPath);
                    if (depResult?.error) {
                        if (traceOrchestrator) {
                            traceOrchestrator.error(depResult.error, {
                                nodeId,
                                depId,
                                pullPath: currentPath,
                                stage: 'dependency'
                            });
                        }
                        node.value = depResult;
                        node.cached = true;
                        return depResult;
                    }
                }
            }

            const errorHandler = this.errorBoundaries.get(nodeId);
            if (errorHandler) {
                try {
                    node.value = node.computation.value;
                } catch (error) {
                    if (traceOrchestrator) {
                        traceOrchestrator.error(error, {
                            nodeId,
                            pullPath: currentPath,
                            stage: 'computation',
                            handled: true
                        });
                    }
                    node.value = errorHandler(error, nodeId);
                }
            } else {
                try {
                    node.value = node.computation.value;
                } catch (error) {
                    if (traceOrchestrator) {
                        traceOrchestrator.error(error, {
                            nodeId,
                            pullPath: currentPath,
                            stage: 'computation',
                            fatal: true
                        });
                    }
                    node.value = { error, value: undefined };
                    node.cached = true;
                    return node.value;
                }
            }

            node.cached = true;

            const endTime = performance.now();
            const endMem = process.memoryUsage().heapUsed;

            if (traceOrchestrator) {
                const key = `pull:${nodeId}`;
                traceOrchestrator.store.performanceMarks.set(key, {
                    duration: endTime - startTime,
                    memDelta: endMem - startMem,
                    timestamp: Date.now(),
                    pullPath: currentPath,
                    cacheHit: false
                });
                traceOrchestrator.store.performanceLRU = traceOrchestrator.store.performanceLRU.filter(k => k !== key);
                traceOrchestrator.store.performanceLRU.push(key);
            }

            if (this.progressCallback) {
                this.progressCallback({
                    pullCount: this.pullCount,
                    nodeId,
                    stage: 'complete',
                    value: node.value,
                    pullPath: currentPath
                });
            }
        } else {
            if (traceOrchestrator) {
                const key = `pull:${nodeId}`;
                traceOrchestrator.store.performanceMarks.set(key, {
                    duration: 0,
                    memDelta: 0,
                    timestamp: Date.now(),
                    pullPath: [...pullPath, nodeId],
                    cacheHit: true
                });
                traceOrchestrator.store.performanceLRU = traceOrchestrator.store.performanceLRU.filter(k => k !== key);
                traceOrchestrator.store.performanceLRU.push(key);
            }
        }

        return node.value;
    }
    
    setProgressCallback(callback) {
        this.progressCallback = callback;
    }
    
   
    invalidate(nodeId) {
        const node = this.objects.get(nodeId);
        if (node) {
            node.cached = false;
            if (this.edges) {
                for (const [id, deps] of this.edges) {
                    if (deps.has(nodeId)) {
                        this.invalidate(id);
                    }
                }
            }
        }
    }

    serialize() {
        const serialized = {
            objects: [],
            morphisms: [],
            pullCount: this.pullCount,
            timestamp: Date.now()
        };

        for (const [id, obj] of this.objects) {
            if (obj.cached && obj.value !== undefined) {
                const entry = {
                    id,
                    value: obj.value,
                    pullCount: obj.pullCount,
                    category: obj.category
                };

                if (obj.contentHash) {
                    entry.contentHash = obj.contentHash;
                }

                serialized.objects.push(entry);
            }
        }

        for (const [morphId, morph] of this.morphisms) {
            serialized.morphisms.push({
                id: morphId,
                source: morph.source,
                target: morph.target
            });
        }

        return serialized;
    }

    static deserialize(data, computationRegistry) {
        const graph = new PullGraph();
        graph.pullCount = data.pullCount;

        for (const obj of data.objects) {
            const computation = computationRegistry?.get(obj.id);
            if (computation) {
                graph.register(obj.id, computation);
                const node = graph.objects.get(obj.id);
                node.cached = true;
                node.value = obj.value;
                node.pullCount = obj.pullCount;
                if (obj.contentHash) {
                    node.contentHash = obj.contentHash;
                }
            }
        }

        for (const morph of data.morphisms) {
            if (graph.objects.has(morph.source) && graph.objects.has(morph.target)) {
                graph.morphism(morph.source, morph.target);
            }
        }

        return graph;
    }

}

// Transform any async operation into pull-based
class PullPromise {
    constructor(asyncThunk) {
        this._thunk = asyncThunk;
        this._promise = null;
        this._started = false;
    }

   
    pull() {
        if (!this._started) {
            this._promise = this._thunk();
            this._started = true;
        }
       
        return Promise.resolve(this._promise);
    }
    
   
    then(onResolve, onReject) {
        return new PullPromise(() => 
            this.pull().then(onResolve, onReject)
        );
    }
    
    map(f) {
        return new PullPromise(() => 
            this.pull().then(f)
        );
    }
}

// Pull-based cache that only computes when accessed
class PullCache {
    constructor(generator) {
        this.generator = generator;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) {
            this.cache.set(key, new Lazy(() => this.generator(key)));
        }
        return this.cache.get(key).value;
    }

    has(key) {
        return this.cache.has(key) && this.cache.get(key)._evaluated;
    }
}

let pullGraph = null;
const CACHE_DIR = path.join(PROJECT_ROOT, '.hct');
const GRAPH_CACHE_PATH = path.join(CACHE_DIR, 'build-graph.json');

const initPullGraph = () => {
    if (!pullGraph) {
        if (fs.existsSync(GRAPH_CACHE_PATH)) {
            const cached = JSON.parse(fs.readFileSync(GRAPH_CACHE_PATH, 'utf8'));
            pullGraph = PullGraph.deserialize(cached, new Map());
        } else {
            pullGraph = new PullGraph();
        }

        pullGraph.setProgressCallback((progress) => {
            if (progress.pullCount % CONFIG.processing.progress.buildProgressLogInterval === 0) {
                logger.log(`[BUILD PROGRESS] Pulled ${progress.pullCount} nodes...`);
            }
        });
    }
    return pullGraph;
};

const savePullGraph = () => {
    if (!pullGraph) throw new Error('Cannot save null pullGraph');
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const serialized = pullGraph.serialize();
    fs.writeFileSync(GRAPH_CACHE_PATH, JSON.stringify(serialized, null, 2));
};

process.on('beforeExit', savePullGraph);
process.on('SIGINT', async () => {
    savePullGraph();
    if (queryServer) await queryServer.stop();
    process.exit(0);
});
process.on('SIGTERM', () => {
    savePullGraph();
    process.exit(0);
});

// Initialize immediately
initPullGraph();

// Lazy file system wrapper
class LazyFS {
    constructor() {
       
        this.readCache = new PullCache((path) => 
            fs.readFileSync(path, CONFIG.strings.standardEncoding)
        );
        
       
        this.writeQueue = new LazyStream(null, null);
        
       
        this.watchers = new Map();
        
       
        this.statCache = new PullCache((path) => fs.statSync(path));
        
       
        this.dirCache = new PullCache((path) => fs.readdirSync(path));
    }

   
    read(path) {
        return new Lazy(() => {
            traceOrchestrator.trace('FS_READ', { path });
            return this.readCache.get(path);
        });
    }
    
    write(path, content) {
        return new PullPromise(async () => {
            traceOrchestrator.trace('FS_WRITE', { path });

           
            if (content instanceof LazyTemplate) {
                content = content.toString();
            } else if (content instanceof Lazy) {
                content = content.value;
            }

            await fs.promises.writeFile(path, content);
            return path;
        });
    }
    
   
    watch(path) {
       
        if (this.watchers.has(path)) {
            return this.watchers.get(path);
        }
        
       
        const stream = new LazyStream(
            { type: 'init', path, time: Date.now() },
            () => {
               
                const watcher = fs.watch(path, { encoding: CONFIG.strings.standardEncoding });
                
               
                let next = null;
                watcher.on('change', (eventType, filename) => {
                    const event = {
                        type: eventType,
                        path: filename ? path.join(path, filename) : path,
                        time: Date.now()
                    };
                    
                   
                    if (!next) {
                        next = new LazyStream(event, () => next);
                    }
                });
                
                watcher.on('error', (err) => {
                    traceOrchestrator.error(err, { path });
                });
                
                return next;
            }
        );
        
        this.watchers.set(path, stream);
        return stream;
    }
    

    exists(path, useCache = true) {
        return new Lazy(() => {
            try {
                if (useCache) {
                    this.statCache.get(path);
                } else {
                    fs.statSync(path);
                }
                return true;
            } catch (err) {
                if (err.code === 'ENOENT') {
                    return false;
                }
                throw err;
            }
        });
    }
    
   
    stat(path) {
        return new Lazy(() => this.statCache.get(path));
    }
    
   
    readdir(path) {
        return new Lazy(() => this.dirCache.get(path));
    }
    
   
    mkdir(path, options = { recursive: true }) {
        return new PullPromise(async () => {
            traceOrchestrator.trace('FS_MKDIR', { path, options });
            await fs.promises.mkdir(path, options);
            return path;
        });
    }
    
    unlink(path) {
        return new PullPromise(async () => {
            traceOrchestrator.trace('FS_UNLINK', { path });

            await fs.promises.unlink(path);
            this.readCache.cache.delete(path);
            this.statCache.cache.delete(path);
            return path;
        });
    }
    
   
    copy(src, dest) {
        return new PullPromise(async () => {
            traceOrchestrator.trace('FS_COPY', { src, dest });
            const content = this.read(src).value;
            await this.write(dest, content).pull();
            return { src, dest };
        });
    }
    
   
    batchWrite(operations) {
        return new PullPromise(async () => {
            const results = [];
            for (const { path, content } of operations) {
                results.push(await this.write(path, content).pull());
            }
            return results;
        });
    }
    
   
    clearCache() {
        this.readCache.cache.clear();
        this.statCache.cache.clear();
        this.dirCache.cache.clear();
    }
}

// Create global lazy file system instance
const lazyFS = new LazyFS();

// Event stream system
class LazyEventSystem {
    constructor() {
       
        this.rootStream = null;
        this.currentTail = null;

        this.eventStore = new Map();
        this.handlers = new Map();
        this.events = new LazyStream(null, () => this.currentTail);

    }
    
   
    emit(event) {
        const enrichedEvent = {
            ...event,
            timestamp: Date.now(),
            id: crypto.randomBytes(CONFIG.processor.hashLength).toString(CONFIG.strings.hashEncoding),
            context: traceOrchestrator.currentContext
        };

       
        const eventType = event.type;
        if (!this.eventStore.has(eventType)) {
            this.eventStore.set(eventType, []);
        }
        this.eventStore.get(eventType).push({
            data: enrichedEvent,
            timestamp: enrichedEvent.timestamp,
            processed: false
        });

       
        const newTail = new LazyStream(enrichedEvent, () => this.currentTail);

       
        if (!this.currentTail) {
            this.currentTail = newTail;
            this.rootStream = newTail;
        } else {
           
            const oldTail = this.currentTail;
            this.currentTail = new LazyStream(enrichedEvent, () => oldTail);
        }

       
        traceOrchestrator.trace('EVENT_EMIT', enrichedEvent);

        return enrichedEvent;
    }
}

// Create global lazy event system
const lazyEvents = new LazyEventSystem();

// Git wrapper for commit workflow
class LazyGit {
    constructor() {
        this.statusCache = new PullCache(() => this._fetchStatus());
        this.diffCache = new PullCache((ref) => this._fetchDiff(ref));
    }

    diff(ref = 'HEAD') {
        return new Lazy(() => {
            lazyEvents.emit({ type: 'git', action: 'diff', ref });
            return this.diffCache.get(ref);
        });
    }

    changedFiles() {
        return new Lazy(() => {
            const status = this.statusCache.get('current');
            if (!status) return [];

            return status
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const file = line.substring(GIT.statusPorcelainColumn).trim();
                    const status = line.substring(0, GIT.statusCodeLength).trim();
                    return { file, status };
                });
        });
    }

    stage(files) {
        return new PullPromise(async () => {
            lazyEvents.emit({ type: 'git', action: 'stage', files });

            const results = [];
            for (const file of files) {
                const exists = lazyFS.exists(file).value;
                if (exists) {
                    const result = execSync(`${CONFIG.strings.addCommand} ${file}`, {
                        encoding: CONFIG.strings.standardEncoding
                    });
                    results.push({ file, result });
                }
            }

            this.statusCache.cache.clear();
            return results;
        });
    }

    commit(options = {}) {
        return new PullPromise(async () => {
            lazyEvents.emit({ type: 'git', action: 'commit', options });

            const result = execSync('git commit --allow-empty-message -m ""', {
                encoding: CONFIG.strings.standardEncoding
            });

            this.statusCache.cache.clear();
            this.diffCache.cache.clear();

            return result;
        });
    }

    push(remote = 'origin', branch = null) {
        return new PullPromise(async () => {
            lazyEvents.emit({ type: 'git', action: 'push', remote, branch });

            const cmd = branch ? `git push ${remote} ${branch}` : `git push ${remote}`;
            const result = execSync(cmd, {
                encoding: CONFIG.strings.standardEncoding
            });

            return result;
        });
    }

    commitWorkflow(files, push = false) {
        const stagePipeline = Pipeline.compose(
            files => this.stage(files),
            staged => new Lazy(() => {
                lazyEvents.emit({ type: 'GIT_STAGED', files: staged });
                return staged;
            })
        );

        const commitPipeline = Pipeline.compose(
            () => this.commit(),
            sha => new Lazy(() => {
                lazyEvents.emit({ type: 'GIT_COMMITTED', sha });
                return sha;
            })
        );

        const pushPipeline = push ? Pipeline.compose(
            () => this.push(),
            result => new Lazy(() => {
                lazyEvents.emit({ type: 'GIT_PUSHED', result });
                return result;
            })
        ) : () => new Lazy(() => 'No push');

        return Pipeline.kleisli(
            stagePipeline,
            commitPipeline,
            pushPipeline
        )(files);
    }

    _fetchStatus() {
        return execSync(CONFIG.strings.statusCommand, {
            encoding: CONFIG.strings.standardEncoding
        });
    }

    _fetchDiff(ref) {
        return execSync(`git diff ${ref}`, {
            encoding: CONFIG.strings.standardEncoding
        });
    }
}

// Create global lazy git instance
const lazyGit = new LazyGit();

// Validate array with expected length
const validateVec = (arr, expectedLength, description) => {
    try {
        checkType(arr, ArrayType);
    } catch (e) {
        throw new Error(`${description}: expected array, got ${typeof arr} - ${e.message}`);
    }
    if (arr.length !== expectedLength) {
        throw new Error(`${description}: expected length ${expectedLength}, got ${arr.length}`);
    }
    if (traceOrchestrator) {
        traceOrchestrator.trace('VEC_VALID', { length: expectedLength, description, actualLength: arr.length });
    }
    return arr;
};

// Serialize runtime objects to plain data for debugging/telemetry
class StateSerializer {
    constructor() {
        this.serializers = new Map();
    }

   
    serialize(typeName, obj) {
        const serializer = this.serializers.get(typeName);
        if (!serializer) return obj;
        return serializer(obj);
    }

   
    register(typeName, serializerFn) {
        this.serializers.set(typeName, serializerFn);
    }
}

const TIME = {
    TICK: 100,
    DEBOUNCE: 500,
    SECOND: 1000,
    TIMEOUT: 5000,
    LONG: 30000,
    VERY_LONG: 60000
};

const TIME_SCHEMA = {
    TICK: { type: 'positiveInt', min: 1 },
    DEBOUNCE: { type: 'positiveInt', min: TIME.TICK },
    SECOND: { type: 'positiveInt', min: TIME.DEBOUNCE },
    TIMEOUT: { type: 'positiveInt', min: TIME.SECOND },
    LONG: { type: 'positiveInt', min: TIME.TIMEOUT },
    VERY_LONG: { type: 'positiveInt', min: TIME.LONG }
};

const LIMITS = {
    RETRIES: 3,
    BATCH: 50,
    MIN_GROUP: 3,
    MEMORY_THRESHOLD: 1073741824,
    RATE_LIMIT_TOKENS: 100,
    PORT_BIND_RETRIES: 10,
    MAX_EVENT_SEQUENCE_DEPTH: 10
};

const LIMITS_SCHEMA = {
    RETRIES: { type: 'positiveInt', min: 1 },
    BATCH: { type: 'positiveInt', min: 1 },
    MIN_GROUP: { type: 'positiveInt', min: 1 },
    MEMORY_THRESHOLD: { type: 'positiveInt', min: 1024 },
    RATE_LIMIT_TOKENS: { type: 'positiveInt', min: 1 },
    PORT_BIND_RETRIES: { type: 'positiveInt', min: 1 },
    MAX_EVENT_SEQUENCE_DEPTH: { type: 'positiveInt', min: 1 }
};

const GIT = {
    statusPorcelainColumn: 3,
    statusCodeLength: 2
};

const GIT_SCHEMA = {
    statusPorcelainColumn: { type: 'positiveInt', min: 1, exact: GIT.statusPorcelainColumn },
    statusCodeLength: { type: 'positiveInt', min: 1, exact: GIT.statusCodeLength }
};

const PRINT = {
    h1: 24,
    h2: 18,
    h3: 14,
    h4: 12,
    body: 11,
    footnote: 9,
    h1TopSpace: 24,
    h1BottomSpace: 12,
    h2TopSpace: 18,
    h2BottomSpace: 9,
    h3TopSpace: 14,
    h3BottomSpace: 7,
    h4TopSpace: 12,
    h4BottomSpace: 6,
    blockSpace: 12,
    inlineSpace: 10,
    indentSpace: 2,
    pdfMarginFraction: 0.75,
    pageMarginFraction: 1,
};

const BINARY = {
    KB: 1024,
    MB: 1048576,
    GB: 1073741824,
};

const CSS = {
    FONT_WEIGHTS: [100, 200, 300, 400, 500, 600, 700, 800, 900]
};

const THRESHOLDS = {
    MEMORY_LEAK_SLOPE: 1000,
    MEMORY_SPIKE_MB: 50,
    ERROR_CLUSTER_WINDOW: 1000,
    TOP_RESULTS: 10,
    AGGREGATE_WINDOW: 10,
    MEMORY_PRESSURE_HIGH: 0.85,
    MAX_FRACTION_DEPTH: 10,
    EVENT_RATE_BUSY: 50,
    VIEWPORT_HEIGHT: 100,
    HASH_SHORT_LENGTH: 16
};

const PRINT_SCHEMA = {
    h1: { type: 'positiveInt', min: PRINT.h2 },
    h2: { type: 'positiveInt', min: PRINT.h3 },
    h3: { type: 'positiveInt', min: PRINT.h4 },
    h4: { type: 'positiveInt', min: PRINT.body },
    body: { type: 'positiveInt', min: PRINT.footnote },
    footnote: { type: 'positiveInt', min: 1 }
};

const BINARY_SCHEMA = {
    KB: { type: 'positiveInt', exact: 1024 },
    MB: { type: 'positiveInt', exact: BINARY.KB * 1024 },
    GB: { type: 'positiveInt', exact: BINARY.MB * 1024 }
};

const THRESHOLDS_SCHEMA = {
    MEMORY_LEAK_SLOPE: { type: 'positiveInt', min: 1 },
    MEMORY_SPIKE_MB: { type: 'positiveInt', min: 1 },
    ERROR_CLUSTER_WINDOW: { type: 'positiveInt', min: 1 },
    TOP_RESULTS: { type: 'positiveInt', min: 1 },
    AGGREGATE_WINDOW: { type: 'positiveInt', min: 1 },
    MEMORY_PRESSURE_HIGH: { type: 'number', min: 0, max: 1 },
    MAX_FRACTION_DEPTH: { type: 'positiveInt', min: 1 },
    EVENT_RATE_BUSY: { type: 'positiveInt', min: 1 },
    VIEWPORT_HEIGHT: { type: 'positiveInt', min: 1 },
    HASH_SHORT_LENGTH: { type: 'positiveInt', min: 1 }
};

class ConfigPatternValidator {
    constructor(enforceStrict = false) {
        this.violations = [];
        this.deprecatedPaths = new Set();
        this.magicNumbers = new Set();
        this.accessLog = [];
        this.computationGraph = new Map(); 
        this.enforceStrict = enforceStrict;
        this.interceptFunctors();
    }
    
    interceptFunctors() {
        this.computationGraph = traceOrchestrator ? traceOrchestrator.events : [];
    }

    extract(value) {
        return traceOrchestrator?.events.find(e => e?.context?.value === value);
    }
    
    detectMagicNumber(value, path) {
        if (typeof value !== 'number') return false;

       
        const configNames = Object.keys(ALL_CONFIGS);
        if (configNames.some(name => path.startsWith(`${name}.`))) {
            return false;
        }

        const context = this.extract(value);

        if (context) {
            if (globalThis.DEBUG_CONFIG_ORIGINS) {
            }
            return false;
        }

        if (value === true || value === false) return false;

        if (path.includes('.weight.') && CSS.FONT_WEIGHTS.includes(value)) {
            this.computationGraph.set(value, { functor: 'CSS_STANDARD', inputs: ['font-weight'], timestamp: 0 });
            return false;
        }

        const unnecessaryIndirections = [
            { pattern: /\.zero$/, value: 0, semantic: 'numeric literal' },
            { pattern: /\.one$/, value: 1, semantic: 'numeric literal' },
            { pattern: /\.two$/, value: 2, semantic: 'numeric literal' },
            { pattern: /\.empty(Check)?Threshold$/, value: 0, semantic: 'empty state indicator' },
            { pattern: /\.topLevelSection$/, value: 1, semantic: 'root hierarchy level' },
        ];

        for (const { pattern, value: expectedValue, semantic } of unnecessaryIndirections) {
            if (pattern.test(path) && value === expectedValue) {
                this.violations.push({
                    type: 'UNNECESSARY_INDIRECTION',
                    path,
                    value,
                    message: `Configuration wraps ${semantic} without domain-specific meaning`
                });
                return false;
            }
        }

        this.magicNumbers.add(`${path} = ${value}`);
        this.violations.push({
            type: 'LITERAL_VALUE',
            path,
            value,
            message: `Numeric value should be replaced with named configuration constant`
        });

        return true;
    }
    
    checkDeprecatedPath(path) {
        const deprecated = [
            'CONFIG.constants',
            'ConfigSchema',
            'ConfigProfiles'
        ];
        
        for (const dep of deprecated) {
            if (path.startsWith(dep)) {
                this.deprecatedPaths.add(path);
                this.violations.push({
                    type: 'DEPRECATED_PATH',
                    path,
                    message: `Deprecated config path: ${path}`
                });
                return true;
            }
        }
        return false;
    }
    
    validateStructure(obj, path = 'CONFIG') {
        if (typeof obj !== 'object' || obj === null) {
            this.detectMagicNumber(obj, path);
            return;
        }
        
        for (const [key, value] of Object.entries(obj)) {
            const fullPath = `${path}.${key}`;
            this.checkDeprecatedPath(fullPath);
            
            if (typeof value === 'object' && value !== null) {
                this.validateStructure(value, fullPath);
            } else {
                this.detectMagicNumber(value, fullPath);
            }
        }
    }
    
    createProxy(obj, path = 'CONFIG') {
        const validator = this;
        return new Proxy(obj, {
            get(target, prop) {
                const fullPath = `${path}.${String(prop)}`;
                validator.accessLog.push({
                    path: fullPath,
                    timestamp: Date.now()
                });
                
                if (prop === 'constants' || prop === 'print' || prop === 'ui' || prop === 'validation') {
                    logger.error(`[CONFIG VIOLATION] Accessing deprecated CONFIG.${prop}`);
                    validator.violations.push({
                        type: 'RUNTIME_DEPRECATED_ACCESS',
                        path: fullPath,
                        message: `Runtime access to deprecated path: ${fullPath}`
                    });
                }
                
                const value = target[prop];
                if (typeof value === 'object' && value !== null) {
                    return validator.createProxy(value, fullPath);
                }
                return value;
            },
            set(target, prop, value) {
                const fullPath = `${path}.${String(prop)}`;
                
                if (validator.detectMagicNumber(value, fullPath)) {
                    logger.error(`[CONFIG VIOLATION] Magic number ${value} assigned to ${fullPath}`);
                }
                
                target[prop] = value;
                return true;
            }
        });
    }
    
    report() {
        if (this.violations.length === 0) {
            logger.log('[CONFIG] No violations detected');
            return null;
        }
        
        logger.error('\n========== CONFIG VIOLATIONS DETECTED ==========');
        logger.error(`Found ${this.violations.length} violations:\n`);
        
        const byType = {};
        for (const v of this.violations) {
            if (!byType[v.type]) byType[v.type] = [];

            byType[v.type].push(v);
        }
        
       
        if (byType.MISSING_RECORD_COMPUTATION) {
            logger.error(`\nMISSING_RECORD_COMPUTATION (${byType.MISSING_RECORD_COMPUTATION.length}) - These computed values need recordComputation():`);
            for (const v of byType.MISSING_RECORD_COMPUTATION) {
                logger.error(`  ⚠ ${v.path} = ${v.value}`);
                logger.error(`    FIX: Wrap with ${v.message.split('needs ')[1]}`);
            }
            delete byType.MISSING_RECORD_COMPUTATION;
        }
        
        if (byType.UNNECESSARY_INDIRECTION) {
            logger.error(`\n[UNNECESSARY_INDIRECTION] (${byType.UNNECESSARY_INDIRECTION.length}) Configuration constants that should be replaced with literals:`);
            for (const v of byType.UNNECESSARY_INDIRECTION) {
                logger.error(`  ${v.path} = ${v.value}`);
                logger.error(`    ${v.message}`);
            }
            delete byType.UNNECESSARY_INDIRECTION;
        }

        if (byType.LITERAL_VALUE) {
            const valueGroups = {};
            for (const v of byType.LITERAL_VALUE) {
                if (!valueGroups[v.value]) valueGroups[v.value] = [];

                valueGroups[v.value].push(v.path);
            }

            logger.error(`\n[LITERAL_VALUE] (${byType.LITERAL_VALUE.length}) Numeric values that should be named constants:`);
            for (const [value, paths] of Object.entries(valueGroups)) {
               
                const sources = paths.map(p => p.split('.')[0]);
                const uniqueSources = [...new Set(sources)];
                const sourceText = uniqueSources.length === 1 ? ` [from ${uniqueSources[0]}]` : '';
                
                if (paths.length > 1) {
                    logger.error(`  Value ${value} appears ${paths.length} times${sourceText}:`);
                    paths.forEach(p => logger.error(`    ${p}`));
                } else {
                    logger.error(`  ${paths[0]} = ${value}${sourceText}`);
                }
            }
            delete byType.LITERAL_VALUE;
        }
        
        for (const [type, violations] of Object.entries(byType)) {
            logger.error(`\n${type} (${violations.length}):`);
            for (const v of violations.slice(0, CONFIG.reporting.defaultDisplayLimit)) {
                logger.error(`  - ${v.message}`);
            }
            if (violations.length > CONFIG.reporting.defaultDisplayLimit) {
                logger.error(`  ... and ${violations.length - CONFIG.reporting.defaultDisplayLimit} more`);
            }
        }
        
        logger.error('\n================================================\n');
        
        if (this.enforceStrict && this.violations.length > 0) {
            logger.error('[FATAL] Categorical structure violated');
            process.exit(1);
        }
        
        return this.violations;
    }
}

const CONFIG_RAW = {};

CONFIG_RAW.core = {
    time: {
        msPerSecond: 1000,
        defaultSleepSeconds: 1
    }
};

CONFIG_RAW.network = {
    websocket: {
        updateInterval: 33,
        maxPayloadSize: 1048576
    },
    errors: {
        addressInUse: 'EADDRINUSE'
    }
};


CONFIG_RAW.processing = {
    polling: {
        intervalMs: 100
    },
    content: {
        maxHeadingLevel: 6,
        minGroupSize: 3
    },
    hash: {
        byteLength: 8
    },
    progress: {
        pullGraphLogInterval: 100,
        buildProgressLogInterval: 1000
    }
};

CONFIG_RAW.events = {
    defaultQueryLimit: 10
};

CONFIG_RAW.performance = {
    percentileThresholds: {
        median: 50,
        good: 70,
        slow: 90,
        verySlow: 95,
        extreme: 99,
        percentBase: 100
    }
};

CONFIG_RAW.reporting = {
    defaultDisplayLimit: 10,
    maxDisplayResults: 20
};

CONFIG_RAW.storage = {
    maxEventCapacity: 10000,
    maxMapCapacity: 1000
};

CONFIG_RAW.markov = {
    minFailureChainLength: 3,
    minSamplesForAnomaly: 5,
    zScoreThreshold: 2.5
};

CONFIG_RAW.resources = {
    defaultBorrowDuration: TIME.SECOND,
    defaultWaitEstimate: TIME.TICK,
    retryLimit: 3,
    retryDelay: TIME.SECOND,
    maxConcurrent: 2
};

CONFIG_RAW.morphisms = {
    aggregator: {
        name: 'generate-index',
        apply: (docs) => renderView({ type: 'document-index' }, docs),
        barrier: 'artifacts',
        timeout: TIME.LONG
    }
};

CONFIG_RAW.documents = {
    content: {
        experienceTitle: 'Higher Category Theory Through Human Experience',
        experienceDescription: 'An exploration of higher category theory through practical examples and human-scale analogies, bridging abstract mathematics with concrete experience.',
        primerTitle: 'Higher Category Theory: A Primer',
        primerDescription: 'A systematic introduction to higher category theory, covering simplicial sets, fibrations, limits, topoi, and their applications in modern mathematics.',
        defaultDescription: 'A comprehensive document on higher category theory and its mathematical foundations.'
    },

    artifacts: {
        workingDoc: {
            name: 'HCT Working Document',
            txt: 'src/HCT_working.txt',
            pdf: 'output/working.pdf',
            html: 'output/working.html',
            md: 'output/working.md'
        },
        primerDoc: {
            name: 'HCT Primer',
            txt: 'src/HCT_primer.txt',
            pdf: 'output/primer.pdf',
            html: 'output/primer.html',
            md: 'output/primer.md'
        },
        indexFile: 'output/index.html',
        readmeFile: 'output/README.md',
        lockFile: 'temp/.build.lock',
        buildScript: 'scripts/builder.js'
    },

    formats: {
        extensions: {
            txt: '.txt',
            pdf: '.pdf',
            html: '.html',
            md: '.md'
        },
        defaultOutputFormats: ['html', 'markdown', 'pdf']
    }
};

Object.assign(CONFIG_RAW, {
    debug: {
        maxEvents: 1000,
        maxMaps: TIME.TICK,
        cleanupInterval: TIME.TICK,
        stackFrameEnd: 7, 
        performanceWarnThreshold: TIME.TICK,
        enableTelemetry: true,
       
        analysis: {
            recentWindowSize: TIME.TICK,
            errorWindowSize: 20,
            memoryTrendSize: LIMITS.BATCH,
            performanceSampleSize: 20,
            topResultsLimit: 5, 
        }
    },
    
   
    scheduler: {
        maxConcurrent: CONFIG_RAW.actors?.orchestration?.maxConcurrent,
        retryLimit: CONFIG_RAW.actors?.orchestration?.retryLimit,
        retryDelayBase: CONFIG_RAW.actors?.orchestration?.retryDelayBase,
        debounceDelay: CONFIG_RAW.actors?.orchestration?.debounceDelay,
        lockCheckInterval: TIME.TICK,
        buildHistoryLimit: LIMITS.BATCH,
        buildHistoryTrim: 25,
        defaultPriority: 0,
        retryPriority: -1,
        initialBuildPriority: 10,
        memoryPressureThreshold: 0.8,
        errorRateThreshold: 0.1,
        scaleDownFactor: 0.75,
        scaleUpFactor: 1.25
    },
    
   
    processor: {
        hashLength: CONFIG_RAW.processing.hash.byteLength,
        sectionIdMaxLength: 100,
        headingMaxLevels: CONFIG_RAW.processing.content.maxHeadingLevel,
        minGroupSize: CONFIG_RAW.processing.content.minGroupSize,
        tocMaxDepth: 2, 
        subSectionLevel: 3, 
        scrollHighlightThreshold: 100, 
        mediumSizeThreshold: 1024,
        largeSizeThreshold: 1048576,
        titleMaxLength: 200,
        codeBlockSliceLength: 3, 
        notFoundIndex: -1, 
        topSectionLevel: 1, 
        majorSectionLevel: 2, 
        debugContextSize: 50, 
        coarsePrecision: 1, 
        signalKillDefault: 0 
    },
    
    latex: {
        maxRecursionDepth: 10,             
        minMatchLength: 10,                
        cacheKeyDepthPrefix: true,         
        logUnhandledCommands: true,        
        debugSubstringLength: LIMITS.BATCH,          
    },
    
   
    browser: {
        launchTimeout: TIME.LONG,         
        pageLoadTimeout: TIME.LONG,       
        pdfTimeout: TIME.VERY_LONG,       
        maxRetries: LIMITS.RETRIES,       
    },
    
   
    watcher: {
        dedupWindow: TIME.TICK,           
        dedupCleanupInterval: TIME.TIMEOUT,// Clean old dedup entries
        initialBuildWaitMax: TIME.LONG,   
        initialBuildCheckInterval: TIME.TICK,
        postBuildDelay: TIME.DEBOUNCE,    
    },
    
   
    process: {
        lockHeartbeatInterval: TIME.SECOND,
        lockTimeout: TIME.TIMEOUT,        
        lockAliveCheckTime: TIME.VERY_LONG,// Max time to consider lock alive
        lockRetryAttempts: 10,            
        lockUpdateInterval: TIME.LONG,
        shutdownTimeout: TIME.TIMEOUT,    
        statsInterval: TIME.TIMEOUT,      
        heartbeatInterval: TIME.LONG,     
        exitCode: {
            success: 0,
            error: 1,
        },
    },
    
   
    git: {
        statusPorcelainColumn: GIT.statusPorcelainColumn,
        commitMessageMaxLength: 0,
    },
    
   
    prediction: {
        failureThreshold: 0.7, 
        remediationThreshold: 0.6, 
        browserRestartThreshold: 0.85, 
    },
    
   
    limits: {
        minPositive: 1,
        minZero: 0,
        maxScaleValue: 10,
        xssPreviewLength: 50,
        minFontSize: 10,
        maxFontSize: 24,
        minDebugEvents: TIME.TICK,
        minDebugMaps: 10,
        minConcurrent: 1,
        maxConcurrent: 10,
        minHashLength: 4,
        maxHashLength: 32,
        htmlHeadingLevels: 6,
        memoryPressureThreshold: new Lazy(() => 9 / 10),
        maxEventRate: new Lazy(() => 100 * 10),
        telemetryWindowSize: 2,
        aggregateWindowSize: 10,
        defaultLimit: 100,
    },

    content: CONFIG_RAW.documents?.content,


    files: (() => {
        const artifacts = CONFIG_RAW.documents?.artifacts;
        const formats = CONFIG_RAW.documents?.formats;
        return {
            sourcePattern: '**/*.txt',
            workingDoc: {
                ...artifacts.workingDoc,
                dependencies: new Lazy(() => ({
                    html: ['txt'],
                    pdf: ['html'],
                    md: ['txt']
                }))
            },
            primerDoc: {
                ...artifacts.primerDoc,
                dependencies: new Lazy(() => ({
                    html: ['txt'],
                    pdf: ['html'],
                    md: ['txt']
                }))
            },
            indexFile: artifacts.indexFile,
            indexDependencies: new Lazy(() => ['workingDoc.html', 'primerDoc.html']),
            readmeFile: artifacts.readmeFile,
            lockFile: artifacts.lockFile,
            buildScript: artifacts.buildScript,
            telemetryFile: 'telemetry.json',
            extensions: formats.extensions,
            defaultOutputFormats: formats.defaultOutputFormats
        };
    })(),
    
   
    strings: {
       
        operationCategories: ['build', 'parse', 'transform', 'pdf', 'latex', 'task'],
        defaultCategory: 'other',
        
       
        errorPatterns: {
            fileNotFound: 'ENOENT',
            resourceClosed: 'Target closed',
            processDetached: 'detached',
            operationTimeout: 'timeout'
        },
        
       
        supportedLanguages: ['text', 'javascript', 'python', 'typescript', 'html', 'css', 'json', 'yaml', 'bash', 'sh', 'markdown', 'md', 'latex', 'tex'],
        defaultLanguage: 'text',
        
       
        codeDelimiter: '```',
        quoteDelimiter: '>',
        mathStartDelimiter: '<<<BLOCKMATH>>>',
        mathEndDelimiter: '<<</BLOCKMATH>>>',
        
       
        structurePrefixes: ['Layer', 'Section', 'Chapter', 'Part'],
        
       
        commandPrefixes: {
            text: 'text',
            roman: 'mathrm',
            bold: 'textbf',
            italic: 'textit',
            fraction: 'frac'
        },
        
       
        semanticElements: {
            emphasis: 'em',
            strong: 'strong',
            superscript: 'sup',
            subscript: 'sub'
        },
        
       
        cliFlags: {
            push: '--push',
            online: '--online'
        },
        
       
        domEvents: {
            contentLoaded: 'DOMContentLoaded',
            scroll: 'scroll'
        },
        
       
        scrollBehavior: {
            smooth: 'smooth',
            auto: 'auto',
            instant: 'instant'
        },
        scrollBlock: {
            start: 'start',
            center: 'center',
            end: 'end',
            nearest: 'nearest'
        },
        
       
        standardEncoding: 'utf8',
        standardEncodingDash: 'utf-8',
        
       
        interruptSignal: 'SIGINT',
        exceptionEvent: 'uncaughtException',
        rejectionEvent: 'unhandledRejection',
        
       
        emptyPageUrl: 'about:blank',
        networkIdleState: 'networkidle0',
        pageFormat: 'letter',
        
       
        windowsPlatform: 'win32',
        windowsSleepCommand: () => `timeout /t ${CONFIG.core.time.defaultSleepSeconds} /nobreak >nul`, 
        unixSleepCommand: () => `sleep ${CONFIG.core.time.defaultSleepSeconds}`,
        
       
        buildSystemVersion: 'HCT Build System v4.0',
        shutdownMessage: '[SHUTDOWN] Closing...',
        startupFailedMessage: '[STARTUP FAILED]',
        fatalErrorPrefix: '[FATAL]',
        errorPrefix: '[ERROR]',
        warningPrefix: '[WARNING]',
        lockPrefix: '[LOCK]',
        lockWaitingMessage: '[LOCK] Waiting for other build to complete...',
        lockStillRunningMessage: '[LOCK] Other build still running, exiting',
        lockErrorPrefix: '[LOCK ERROR]',
        lockCleanupErrorPrefix: '[LOCK CLEANUP ERROR]',
        criticalErrorPrefix: '[CRITICAL ERROR]',
        unhandledRejectionPrefix: '[UNHANDLED REJECTION]',
        shutdownBrowserErrorPrefix: '[SHUTDOWN] Browser cleanup error:',
        fatalLockMessage: '[FATAL] Could not acquire process lock',
        watchPrefix: '[WATCH]',
        watchFilePrefix: '[WATCHFILE]',
        watchingPrefix: '[WATCHING]',
        indexGenerated: '[INDEX] Generated index.html',
        
       
        statusCommand: 'git status --porcelain',
        diffCommand: 'git diff --cached --name-only',
        addCommand: 'git add',
        logCommand: 'git log --oneline -n 5',
        
       
        documentTitle: 'Higher Category Theory',
        metadataSeparator: ' · ', 
        projectAbbreviation: 'HCT',
        buildVersion: 'v4.0',     
        
       
        timeLocale: 'en-US',
        timeFormat: '2-digit',
        hourFormat12: false,
        
       
        defaultLanguage: 'en',
        standardCharset: 'UTF-8',
        viewportContent: 'width=device-width, initial-scale=1.0',
        cacheControlContent: 'no-cache, no-store, must-revalidate',
        pragmaContent: 'no-cache',
        expiresContent: '0',
        
       
        sandboxFlag: '--no-sandbox',
        setuidFlag: '--disable-setuid-sandbox',
        devShmFlag: '--disable-dev-shm-usage',
        gpuFlag: '--disable-gpu',
        zygoteFlag: '--no-zygote',
        headlessMode: 'new',
        
       
        primaryFont: 'Helvetica Neue',
        secondaryFont: 'Helvetica',
        fallbackFont: 'Arial',
        sansSerif: 'sans-serif',
        primaryFontStack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        fallbackFontStack: "'Arial', sans-serif",
        
       
        mainHashAlgorithm: 'sha256',    
        fallbackHashAlgorithm: 'md5',   
        hashEncoding: 'hex',
        
       
        smallSizeUnit: ' B',
        mediumSizeUnit: ' KB',
        largeSizeUnit: ' MB',
        
       
        sectionIdPrefix: 'sec-',
        sectionFallback: 'section',
        
       
        classActive: 'active',
        classExpanded: 'expanded',
        classCollapsed: 'collapsed',
       
        blockContentClass: 'math-block',
        inlineContentClass: 'math-inline',
        textInsideClass: 'text-in-math',
        operatorClass: 'operator',
        romanStyleClass: 'mathrm',
        calligraphicClass: 'mathcal',
        blackboardClass: 'mathbb',
        frakturClass: 'mathfrak',
        sansSerifClass: 'mathsf',
        boldStyleClass: 'mathbf',
        annotatedElementClass: 'arrow-with-text',
        annotationTextClass: 'arrow-text',
        tildeAccentClass: 'tilde',
        hatAccentClass: 'hat',
        barAccentClass: 'bar',
        dotAccentClass: 'dot',
        vectorClass: 'vec',
        fractionClass: 'frac',
        numeratorClass: 'num',
        denominatorClass: 'den',
       
        navigationContentClass: 'toc-content',
        navigationSectionClass: 'toc-section',
        navigationMajorClass: 'toc-major',
        toggleIconClass: 'toggle-icon',
        spacerClass: 'toc-spacer',
        navigationLinkClass: 'toc-link',
        navigationNumberClass: 'toc-number',
        childrenContainerClass: 'toc-children',
        anchorLinkClass: 'anchor-link',
        toggleControlClass: 'toc-toggle',
       
        sidebarClass: 'toc-sidebar',
        headerClass: 'toc-header',
        expandControlClass: 'expand-all',
        contentClass: 'content',
        documentSectionClass: 'document-section',
        sectionHeadingClass: 'section-heading',
       
        blockElement: 'div',
        inlineElement: 'span',
        linkElement: 'a',
        listItemElement: 'li',
       
        collapsedIndicator: '▶',
        expandedIndicator: '▼',
        anchorSymbol: '#',
       
        expandedAttribute: 'aria-expanded',
       
        expandAllLabel: 'Expand All',
        collapseAllLabel: 'Collapse All',
        contentsLabel: 'Contents',
    },
    
   
    colors: {
       
        text: {
            body: '#2c3e50',         
            heading: '#333',         
            emphasis: '#000',        
            muted: '#777',           
            disabled: '#999',        
            code: '#d73a49',         
        },
       
        background: {
            main: '#ffffff',         
            subtle: '#fafafa',       
            sidebar: '#f8f9fa',      
            code: '#f6f8fa',         
            highlight: '#f5f5f5',    
        },
       
        border: {
            default: '#e4e8ee',      
            light: '#e8e8e8',        
            medium: '#e0e0e0',       
        },
       
        link: {
            default: '#0366d6',
            hover: '#0052a3',        
            active: '#0056b3',       
            visited: '#2c5aa0',      
        },
       
        shadowBase: 'rgba(0,0,0,',   
        neutralBase: 'white',         
    },
    
   
    patterns: {
       
        blockMathBrackets: /\\\[\s*([\s\S]*?)\s*\\\]/g,
        inlineMathParens: /\\\((.*?)\\\)/g,
        blockMathMarker: /<<<BLOCKMATH>>>(.+?)<<<\/BLOCKMATH>>>/gs,
        inlineMathMarker: /<<<INLINEMATH>>>(.+?)<<<\/INLINEMATH>>>/g,
        codeBlocks: /```[\s\S]*?```/g,
        
       
        hashHeading: new RegExp(`^(#{1,${6}})\\s+(.+?)\\s*$`), 
        setextPrimary: /^=+\s*$/,
        setextSecondary: /^-+\s*$/,
        horizontalRule: new RegExp(`^[-*_]{${3},}$`), 
        
       
        unorderedList: /^[-*+•]\s+/,
        orderedList: /^\d+[.)]\s+/,
        
       
        nonWordChars: /[^\w\s-]/g,
        multiSpace: /\s+/g,
        multiDash: /-+/g,
        trimDash: /^-|-$/g,
        
       
        arrayEnv: /\\begin\{array\}(?:\{[^}]*\})?([\s\S]+?)\\end\{array\}/g,
        alignedEnv: /\\begin\{aligned\}([\s\S]+?)\\end\{aligned\}/g,
        matrixEnv: /\\begin\{[bp]?matrix\}([\s\S]+?)\\end\{[bp]?matrix\}/g,
        operatorName: /\\operatorname\{([^}]+)\}/g,
        
       
        mathSymbols: /(\s|^)(→|←|⇒|⇐|↔|⇔|↦|∈|∉|⊂|⊃|⊆|⊇|≤|≥|≠|∼|≃|≅|≡|≈)(\s|$)/g,

       
        sectionCount: null,
        capitalStart: /^[A-Z]/,
        layerOrSection: /^(?:Layer|Section) \d+:/, 
        documentFilePattern: /^HCT_.*\.txt$/, 
        documentPrefix: /^HCT_/,              
        txtExtension: /\.txt$/,               
    },
    
   
    css: {
       
        boxModel: {
            border: 'border-box',
            content: 'content-box'
        },
       
        display: {
            none: 'none',
            block: 'block',
            inline: 'inline',
            inlineBlock: 'inline-block',
            flex: 'flex',
            table: 'table',
            inlineTable: 'inline-table'
        },
       
        position: {
            static: 'static',
            relative: 'relative',
            absolute: 'absolute',
            fixed: 'fixed',
            sticky: 'sticky'
        },
       
        align: {
            start: 'left',
            center: 'center',
            end: 'right',
            justify: 'justify',
            spaceBetween: 'space-between',
            spaceAround: 'space-around'
        },
       
        textDecoration: {
            none: 'none',
            underline: 'underline',
            lineThrough: 'line-through'
        },
       
        cursor: {
            default: 'default',
            pointer: 'pointer',
            text: 'text'
        }
    },
    
   
    ui: {
       
        spacing: {
           
            micro: 2,                            
            tiny: 4,                     
            small: 6,                     
            compact: 8,
            normal: 12,
            medium: 16,
            large: 24,
            huge: 32,
            massive: 48,     
            giant: 64,
        },
       
        typography: {
            weight: {
                light: 3 * 100, 
                regular: 400, 
                medium: 5 * 100, 
                semibold: 6 * 100, 
                bold: 7 * 100, 
            },
           
            scale: {
                tiny: 0.75, 
                small: 0.875, 
                base: 1, 
                medium: 1.125,
                large: 1.25, 
                xlarge: 1.5, 
                huge: 2, 
                giant: 2.5, 
                massive: 3, 
            },
           
            emScale: {
                tiny: 0.1,
                small: 0.2,
                medium: 0.3, 
                regular: 0.4,
                large: 0.5,
                xlarge: 0.8,
                base: 1,
                larger: 1.1,
            },
           
            pixels: {
                tiny: 12,
                small: 13,
                body: 15,
                base: 16,
                medium: 18,
                large: 20,
                xlarge: 22,
                huge: 32,
            },
            lineHeight: {
                tight: 1.25, 
                snug: 1.375, 
                normal: 1.5, 
                relaxed: 1.625, 
                loose: 1.75, 
            },
            letterSpacing: {
                tight: -0.5,
                normal: 0,
                loose: 0.5,
            }
        },
       
        shadow: {
            opacity: {
                subtle: 0.041666666666666664, 
                light: 0.1, 
                medium: 0.15, 
                strong: 0.2, 
            },
            offset: {
                none: 0,
                small: 1,
                medium: 2,
                large: 4,
            },
            blur: {
                sharp: 0,
                soft: 2,
                medium: 4,
                large: 8,
                xlarge: 16,
            }
        },
       
        radius: {
            none: 0,
            small: 3,
            medium: 6,
            large: 12,
            full: Number.MAX_SAFE_INTEGER,
        },
       
        opacity: {
            transparent: 0,
            faint: 0.1, 
            light: 0.3, 
            medium: 0.5, 
            strong: 0.7, 
            heavy: 0.9, 
            opaque: 1,
        },
       
        transition: {
            instant: 0,
            fast: 0.15,     
            normal: 0.2, 
            slow: 0.3,     
            lazy: 0.5, 
        },
       
        zIndex: {
            below: -1,
            base: 0,
            dropdown: 1000,
            sticky: 1100,
            overlay: 1200,
            modal: 1300,
            popover: 1400,
            tooltip: 1500,
        },
       
        layout: {
            sidebarWidth: 320,
            contentMaxWidth: 900,
            contentWideWidth: 960,
            mediaBreakpoint: 900,
            bannerPadding: 38,
            toggleButtonWidth: 20,
            tocIndent: 28,
            hashSliceStart: 1,
        },
       
        borderWidth: 1, 
        scrollDebounceDelay: TIME.TICK,
       
        transform: {
            offscreen: 'translateX(-100%)',
            halfway: 'translateX(-50%)',
            none: 'translateX(0)',
        },
       
        dimensions: {
            full: '100%',
            half: '50%',
            quarter: '25%',
            none: '0',
        },
       
        cssProps: {
            all: 'all',
            ease: 'ease',
        },
       
        pdfMargin: `${PRINT.pdfMarginFraction}in`
    },
    
   
    urls: {
        repositoryLink: 'https://github.com/J0pari/Higher-Category-Theory', 
    },
    
   
    print: {
       
        fontSize: {
            h1: PRINT.h1,
            h2: PRINT.h2,
            h3: PRINT.h3,
            h4: PRINT.h4,
            body: PRINT.body,
            footnote: PRINT.footnote,
        },
       
        spacing: {
            h1: { top: PRINT.h1TopSpace, bottom: PRINT.h1BottomSpace },
            h2: { top: PRINT.h2TopSpace, bottom: PRINT.h2BottomSpace },
            h3: { top: PRINT.h3TopSpace, bottom: PRINT.h3BottomSpace },
            h4: { top: PRINT.h4TopSpace, bottom: PRINT.h4BottomSpace },
            block: PRINT.blockSpace,
            inline: PRINT.inlineSpace,
            indent: PRINT.indentSpace,
        },
        pageMargin: `${PRINT.pageMarginFraction}in`,
    },
    
   
    errors: {
        detachedFrame: 'detached',
        closedContext: 'closed',
        targetClosed: 'Target closed',
        sessionClosed: 'Session closed',
    },
});

const CONFIG = CONFIG_RAW;

// Path resolution helpers - single source of truth for all path construction
CONFIG.resolvePath = (relativePath) => path.join(PROJECT_ROOT, relativePath);
CONFIG.resolveDocPath = (doc, format) => CONFIG.resolvePath(doc[format]);

// CONFIG STRUCTURE

// Move profileValues directly into ConfigProfiles where they belong
const CONFIG_PROFILES = {
    development: {
        debug: { 
            enableTelemetry: true, 
            maxEvents: 10 * 1000,
            cleanupInterval: 60 * 1000
        },
        scheduler: { 
            maxConcurrent: 2, 
            retryLimit: 5 
        },
        browser: { headless: false },
        mode: { strict: true }
    },
    production: {
        debug: { 
            enableTelemetry: false, 
            maxEvents: 1000,
            cleanupInterval: TIME.LONG 
        },
        scheduler: { 
            maxConcurrent: 4, 
            retryLimit: 3 
        },
        browser: { headless: true },
        mode: { strict: false }
    },
    test: {
        debug: { 
            enableTelemetry: true, 
            maxEvents: TIME.TICK, 
            cleanupInterval: 1000 
        },
        scheduler: { 
            maxConcurrent: 1, 
            retryLimit: 1 
        },
        browser: { headless: true },
        mode: { strict: true }
    }
};

// Configuration validation schema
const CONFIG_SCHEMA = {
    debug: {
        properties: {
            maxEvents: { type: 'number', min: CONFIG.limits.minDebugEvents },
            maxMaps: { type: 'number', min: CONFIG.limits.minDebugMaps }
        }
    },
    scheduler: {
        properties: {
            maxConcurrent: { type: 'number', min: CONFIG.limits.minConcurrent, max: CONFIG.limits.maxConcurrent },
            retryLimit: { type: 'number', min: 1, max: 10 }
        }
    },
    processor: {
        properties: {
            hashLength: { type: 'number', min: CONFIG.limits.minHashLength, max: CONFIG.limits.maxHashLength },
            headingMaxLevels: { type: 'number', exact: CONFIG.limits.htmlHeadingLevels },
            tocMaxDepth: { type: 'number', max: CONFIG.processor.headingMaxLevels }
        }
    },
    ui: {
        properties: {
            typography: {
                properties: {
                    scale: {
                        type: 'object',
                        valueSchema: { type: 'number', min: CONFIG.limits.minZero, max: CONFIG.limits.maxScaleValue }
                    },
                    pixels: {
                        properties: {
                            base: { type: 'number', min: CONFIG.limits.minFontSize, max: CONFIG.limits.maxFontSize }
                        }
                    }
                }
            }
        }
    }
};

CONFIG.patterns.sectionCount = new RegExp(`^#{${1},${CONFIG.processor.subSectionLevel}}\\s+`, 'gm');

// Initialize validator
configPatternValidator = new ConfigPatternValidator(true);

// ACTIVATE VALIDATION


const ALL_CONFIGS = {
    TIME,
    TIME_SCHEMA,
    LIMITS,
    LIMITS_SCHEMA,
    GIT,
    GIT_SCHEMA,
    PRINT,
    PRINT_SCHEMA,
    BINARY,
    BINARY_SCHEMA,
    CSS,
    THRESHOLDS,
    THRESHOLDS_SCHEMA,
    CONFIG_RAW,
    CONFIG,
    CONFIG_SCHEMA
};


// Validate each configuration object
for (const [name, obj] of Object.entries(ALL_CONFIGS)) {
    configPatternValidator.validateStructure(obj, name);
}


configPatternValidator.report();

// Resource pools for managing system resources
const ResourcePools = {
    retries: {
        total: CONFIG.resources.retryLimit * CONFIG.resources.maxConcurrent,
        available: CONFIG.resources.retryLimit * CONFIG.resources.maxConcurrent,
        allocate(n = 1) {
            if (this.available < n) return false;
            this.available -= n;
            return true;
        },
        release(n = 1) {
            this.available = Math.min(this.available + n, this.total);
        }
    },
    concurrent: {
        limit: CONFIG.resources.maxConcurrent,
        active: 0,
        canAllocate() { return this.active < this.limit; },
        allocate() { 
            if (!this.canAllocate()) return false;
            this.active++;
            return true;
        },
        release() { this.active = Math.max(0, this.active - 1); }
    }
};

// CONFIGURATION SCHEMA

// type validation via refinement types
const checkType = (value, validator) => {
    if (validator.apply) return validator.apply(value);
    if (!validator.contains(value)) throw new Error('Type check failed');
};


// exact value matching
const checkExact = (value, target) => {
    if (value !== target) return `Not exact ${target}`;
};

// recursive schema validation with error collection
class SchemaValidator {
    constructor(types) {
        this.types = types;
    }

    validateValue(value, typeName) {
        const validator = this.types[typeName];
        if (!validator) throw new Error(`Unknown type: ${typeName}`);
        checkType(value, validator);
    }

    validateSchema(obj, schema, path = '') {
        const errors = [];
        const warnings = [];

        const validateNode = (node, schemaNode, nodePath) => {
            if (!schemaNode) {
                throw new Error(`No schema node provided for validation at path: ${nodePath}`);
            }

            if (schemaNode.type) {
                try {
                    this.validateValue(node, schemaNode.type);
                } catch (e) {
                    errors.push({ path: nodePath, error: e.message, value: node });
                    return;
                }

                if (schemaNode.type === 'number') {
                    if (schemaNode.min !== undefined && node < schemaNode.min) {
                        errors.push({ path: nodePath, error: `Below minimum ${schemaNode.min}`, value: node });
                    }
                    if (schemaNode.max !== undefined && node > schemaNode.max) {
                        errors.push({ path: nodePath, error: `Above maximum ${schemaNode.max}`, value: node });
                    }

                    if (schemaNode.exact !== undefined) {
                        const warning = checkExact(node, schemaNode.exact);
                        if (warning) warnings.push({ path: nodePath, warning, value: node });
                    }
                }
            }

            if (schemaNode.items && Array.isArray(node)) {
                node.forEach((item, idx) => {
                    validateNode(item, schemaNode.items, `${nodePath}[${idx}]`);
                });
            }

            if (schemaNode.valueSchema && node && typeof node === 'object') {
                for (const [key, value] of Object.entries(node)) {
                    validateNode(value, schemaNode.valueSchema, `${nodePath}.${key}`);
                }
            }

            if (schemaNode.properties && node && typeof node === 'object') {
                for (const [key, subSchema] of Object.entries(schemaNode.properties)) {
                    if (node[key] !== undefined) {
                        validateNode(node[key], subSchema, `${nodePath}.${key}`);
                    } else if (subSchema.required) {
                        errors.push({ path: `${nodePath}.${key}`, error: 'Required property missing' });
                    }
                }
            }
        };

        for (const [key, schemaNode] of Object.entries(schema)) {
            if (obj[key] !== undefined) {
                validateNode(obj[key], schemaNode, `${path}.${key}`);
            } else if (schemaNode.required) {
                errors.push({ path: `${path}.${key}`, error: 'Required section missing' });
            }
        }

        return { errors, warnings };
    }
}

const NumberType = { contains: v => typeof v === 'number' };
const StringType = { contains: v => typeof v === 'string' };
const BoolType = { contains: v => typeof v === 'boolean' };
const ArrayType = { contains: v => Array.isArray(v) };
const ObjectType = { contains: v => typeof v === 'object' && v !== null && !Array.isArray(v) };

const PositiveInt = {
    contains: n => typeof n === 'number' && n > 0 && Number.isInteger(n)
};
const NonNegativeInt = {
    contains: n => typeof n === 'number' && n >= 0 && Number.isInteger(n)
};
const ValidPath = {
    contains: p => {
        try {
            return typeof p === 'string' && fs.existsSync(p);
        } catch (e) {
            throw new Error(`Failed to check path existence for ${p}: ${e.message}`);
        }
    }
};
const NonEmptyString = {
    contains: s => typeof s === 'string' && s.length > 0
};

class ConfigValidator {
    constructor(schema, debuggerInstance) {
        this.schema = schema;
        this.debugger = debuggerInstance;
        this.validator = new SchemaValidator({
            number: NumberType,
            string: StringType,
            boolean: BoolType,
            array: ArrayType,
            object: ObjectType,
            positiveInt: PositiveInt,
            nonNegativeInt: NonNegativeInt,
            nonEmptyString: NonEmptyString,
            validPath: ValidPath
        });
    }

    validate(config, path = 'CONFIG') {
        const result = this.validator.validateSchema(config, this.schema, path);

        result.errors.forEach(e => {
            this.debugger.error(new Error(e.error), { path: e.path, value: e.value });
        });
        result.warnings.forEach(w => {
            this.debugger.trace('CONFIG_WARNING', w);
        });

        return result;
    }
}

// Load configuration with profile support
function loadConfig(profile = process.env.NODE_ENV) {
   
    let config = CONFIG;
    
   
    if (CONFIG_PROFILES[profile]) {
        config = deepMerge(config, CONFIG_PROFILES[profile]);
        traceOrchestrator.trace('CONFIG_PROFILE_LOADED', { profile });
    }
    
    return config;
}

// Deep merge helper
function deepMerge(target, source) {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!result[key]) result[key] = {};
            result[key] = deepMerge(result[key], value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

// CONFIGURATION VALIDATION

function validateConfig() {
    const errors = [];
    
   
    const validateNoXSS = (obj, path = 'CONFIG') => {
        const xssPatterns = [
            /<script/i,
            /javascript:/i,
            /on\w+\s*=/i, 
            /eval\(/i,
            /expression\(/i
        ];
        
        for (const [key, value] of Object.entries(obj)) {
            const fullPath = `${path}.${key}`;
            if (typeof value === 'string') {
                for (const pattern of xssPatterns) {
                    if (pattern.test(value)) {
                        errors.push(`Potential XSS in ${fullPath}: "${value.substring(0, CONFIG.limits.xssPreviewLength)}..."`);
                    }
                }
            } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RegExp)) {
                validateNoXSS(value, fullPath);
            }
        }
    };
    
    validateNoXSS(CONFIG);
    
   
    const transitions = [
        CONFIG.ui.transition.fast,
        CONFIG.ui.transition.normal,
        CONFIG.ui.transition.slow
    ];
    
    if (!transitions.every((t, i) => i === 0 || t >= transitions[i-1])) {
        errors.push('Transition durations should be ordered: fast < normal < slow');
    }
    
    
   
    const configStr = JSON.stringify(CONFIG);
    const suspiciousPatterns = [
        /timeout\d+/i,
        /margin\d+[^:]/i,
        /padding\d+[^:]/i,
        /size\d+[^:]/i,
    ];
    
    for (const pattern of suspiciousPatterns) {
        if (pattern.test(configStr)) {
            errors.push(`Suspicious tautological naming detected: ${pattern}`);
        }
    }
    
    if (errors.length > 0) {
        logger.error('Configuration validation failed:');
        errors.forEach(err => logger.error(`  - ${err}`));
        throw new Error('Invalid configuration');
    }
    
    
   
    const SCHEMA_MAP = {
        TIME: TIME_SCHEMA,
        LIMITS: LIMITS_SCHEMA,
        GIT: GIT_SCHEMA,
        PRINT: PRINT_SCHEMA,
        BINARY: BINARY_SCHEMA,
        THRESHOLDS: THRESHOLDS_SCHEMA,
        CONFIG: CONFIG_SCHEMA
    };

    const allValidations = [];
    for (const [name, schema] of Object.entries(SCHEMA_MAP)) {
        const validator = new ConfigValidator(schema, traceOrchestrator);
        const config = ALL_CONFIGS[name];
        if (config) {
            allValidations.push(validator.validate(config, name));
        }
    }

    for (const validation of allValidations) {
        if (validation.errors.length > 0) {
            validation.errors.forEach(e => {
                logger.error(`  ${e.path}: ${e.error}`);
                traceOrchestrator.error(new Error(e.error), { path: e.path, value: e.value });
            });
            errors.push(...validation.errors.map(e => `${e.path}: ${e.error}`));
        }

        if (validation.warnings.length > 0) {
            validation.warnings.forEach(w => {
                logger.warn(`  ${w.path}: ${w.warning}`);
                traceOrchestrator.trace('CONFIG_WARNING', w);
            });
        }
    }
    
   
    if (errors.length > 0) {
        process.exit(CONFIG.process.exitCode.error);
    }
    
   
    ResourcePools.retries.total = CONFIG.resources.retryLimit * CONFIG.resources.maxConcurrent;
    ResourcePools.retries.available = ResourcePools.retries.total;
    ResourcePools.concurrent.limit = CONFIG.resources.maxConcurrent;
    
    const allWarnings = allValidations.flatMap(v => v.warnings);
    return { errors: [], warnings: allWarnings };
}

// TRACE ANALYSIS & RUNTIME VERIFICATION

// EventStore - pure data storage
class EventStore {
    constructor(maxEvents = CONFIG.storage.maxEventCapacity, maxMaps = CONFIG.storage.maxMapCapacity) {
        this.events = [];
        this.errors = new Map();
        this.causality = new Map();
        this.stackTraces = new Map();
        this.performanceMarks = new Map();
        this.runtimeViolations = new Set();
        this.violationsReported = false;
        this.maxEvents = maxEvents;
        this.maxMaps = maxMaps;
        this.currentContext = null;

       
        this.errorLRU = [];
        this.causalityLRU = [];
        this.stackTraceLRU = [];
        this.performanceLRU = [];
    }

    append(event) {
        this.events.push(event);
        if (this.events.length > this.maxEvents) {
            this.events = this.events.slice(-this.maxEvents);
        }

        if (this.currentContext) {
            if (!this.causality.has(this.currentContext.id)) {
                this.causality.set(this.currentContext.id, []);
            }
            this.causality.get(this.currentContext.id).push(event.id);
           
            this.causalityLRU = this.causalityLRU.filter(k => k !== this.currentContext.id);
            this.causalityLRU.push(this.currentContext.id);
        }

        this.currentContext = event;

       
        if (this.events.length % 100 === 0) {
            this.cleanup();
        }

        return event.id;
    }

    explainFailure(eventId) {
        const chain = [];
        let current = this.events.find(e => e.id === eventId);
        while (current) {
            chain.unshift(current);
            current = current.parent ? this.events.find(e => e.id === current.parent) : null;
        }
        return chain;
    }

    cleanup() {
        const trimMapLRU = (map, lru) => {
            while (map.size > this.maxMaps && lru.length > 0) {
                const oldest = lru.shift();
                map.delete(oldest);
            }
        };
        trimMapLRU(this.errors, this.errorLRU);
        trimMapLRU(this.causality, this.causalityLRU);
        trimMapLRU(this.stackTraces, this.stackTraceLRU);
        trimMapLRU(this.performanceMarks, this.performanceLRU);
    }
}

// CausalAnalysis - Markov chain prediction & failure patterns
class CausalAnalysis {
    constructor(eventStore) {
        this.store = eventStore;
    }


    explainFailure(errorId) {
        const chain = [];
        const events = this.store.events;
        let current = events.find(e => e.id === errorId);

        while (current) {
            chain.unshift(current);
            if (!current.parent) break;
            current = events.find(e => e.id === current.parent);
        }

        if (chain.length === 0) {
            throw new Error(`No causal chain found for error ${errorId}`);
        }

        const steps = chain.map((event, index) => {
            const duration = index > 0 ? event.timestamp - chain[index - 1].timestamp : 0;
            return {
                event: event.event,
                duration,
                context: event.context
            };
        });

        const totalDuration = chain[chain.length - 1].timestamp - chain[0].timestamp;

        return {
            error: chain[chain.length - 1].event,
            totalDuration,
            steps
        };
    }

    getNextEvents(eventId) {
        return this.store.events.filter(e => e.parent === eventId);
    }

    buildTransitionData() {
        const transitions = new Map();

        const eventsWithParents = this.store.events.filter(event => event.parent);

        eventsWithParents.forEach(event => {
            const parent = this.store.events.find(e => e.id === event.parent);
            if (!parent) {
                throw new Error(`Event ${event.id} references nonexistent parent ${event.parent}`);
            }

            const key = `${parent.event} → ${event.event}`;
            if (!transitions.has(key)) {
                transitions.set(key, {
                    from: parent.event,
                    to: event.event,
                    durations: []
                });
            }
            transitions.get(key).durations.push(event.timestamp - parent.timestamp);
        });

        return transitions;
    }

    getFailurePredictors() {
        const errorEvents = this.store.events.filter(e => e.event.includes('ERROR'));
        const patterns = new Map();

        const longEnoughFailures = errorEvents
            .map(error => ({ error, failure: this.explainFailure(error.id) }))
            .filter(({ failure }) => failure.steps.length >= CONFIG.markov.minFailureChainLength);

        longEnoughFailures.forEach(({ error, failure }) => {
            const preErrorSteps = failure.steps.slice(0, -1);
            const patternKey = preErrorSteps.map(s => s.event).join(' → ');

            if (!patterns.has(patternKey)) {
                patterns.set(patternKey, {
                    pattern: preErrorSteps.map(s => s.event),
                    leadsToError: error.event,
                    occurrences: 0,
                    avgTimeToFailure: 0,
                    durations: []
                });
            }

            const pattern = patterns.get(patternKey);
            pattern.occurrences++;
            pattern.durations.push(failure.totalDuration);
        });

        return Array.from(patterns.values()).map(p => {
            p.avgTimeToFailure = Math.round(p.durations.reduce((a, b) => a + b, 0) / p.durations.length);
            delete p.durations;
            return p;
        }).sort((a, b) => b.occurrences - a.occurrences);
    }

    getCriticalPath() {
        const roots = this.store.events.filter(e => !e.parent);
        let longestPath = null;
        let maxDuration = 0;

        const findPath = (eventId, currentPath = [], currentDuration = 0) => {
            const event = this.store.events.find(e => e.id === eventId);
            if (!event) {
                throw new Error(`Event ${eventId} not found in event store`);
            }

            const path = [...currentPath, { event: event.event, timestamp: event.timestamp }];
            const children = this.getNextEvents(eventId);

            if (children.length === 0) {
                if (currentDuration > maxDuration) {
                    maxDuration = currentDuration;
                    longestPath = path;
                }
                return;
            }

            children.forEach(child => {
                const duration = child.timestamp - event.timestamp;
                findPath(child.id, path, currentDuration + duration);
            });
        };

        roots.forEach(root => findPath(root.id));

        if (!longestPath) {
            throw new Error('No critical path found - event store may be empty');
        }

        const steps = longestPath.map((step, index) => {
            const duration = index > 0 ? step.timestamp - longestPath[index - 1].timestamp : 0;
            return {
                event: step.event,
                duration
            };
        });

        return {
            totalDuration: maxDuration,
            steps
        };
    }

    getBottlenecks() {
        const transitions = this.buildTransitionData();

        return Array.from(transitions.values()).map(stat => {
            const avg = stat.durations.reduce((a, b) => a + b, 0) / stat.durations.length;
            const max = Math.max(...stat.durations);
            return {
                from: stat.from,
                to: stat.to,
                count: stat.durations.length,
                avgDuration: Math.round(avg),
                maxDuration: max
            };
        }).sort((a, b) => b.avgDuration - a.avgDuration);
    }

    getAnomalies() {
        const transitions = this.buildTransitionData();
        const anomalies = [];
        const MIN_SAMPLES = CONFIG.markov.minSamplesForAnomaly;
        const Z_SCORE_THRESHOLD = CONFIG.markov.zScoreThreshold;

        const transitionsWithEnoughSamples = Array.from(transitions.values())
            .filter(stat => stat.durations.length >= MIN_SAMPLES);

        transitionsWithEnoughSamples.forEach((stat) => {

            const sorted = [...stat.durations].sort((a, b) => a - b);
            const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
            const stdDev = Math.sqrt(
                sorted.reduce((sum, d) => sum + Math.pow(d - avg, 2), 0) / sorted.length
            );

            stat.durations.forEach((duration) => {
                const zScore = Math.abs((duration - avg) / stdDev);
                if (zScore > Z_SCORE_THRESHOLD) {
                    anomalies.push({
                        from: stat.from,
                        to: stat.to,
                        duration,
                        avg: Math.round(avg),
                        stdDev: Math.round(stdDev),
                        zScore: zScore.toFixed(2)
                    });
                }
            });
        });

        return anomalies.sort((a, b) => b.zScore - a.zScore);
    }

    getTransitionMatrix() {
        const transitions = this.buildTransitionData();
        const states = new Map();

        transitions.forEach((stat) => {
            if (!states.has(stat.from)) {
                states.set(stat.from, {
                    total: 0,
                    transitions: new Map(),
                    durations: []
                });
            }

            const fromState = states.get(stat.from);
            fromState.total += stat.durations.length;
            fromState.durations.push(...stat.durations);

            if (!fromState.transitions.has(stat.to)) {
                fromState.transitions.set(stat.to, { count: 0, durations: [] });
            }

            const transition = fromState.transitions.get(stat.to);
            transition.count += stat.durations.length;
            transition.durations.push(...stat.durations);
        });

        return Array.from(states.entries()).map(([fromEvent, data]) => {
            const avgDuration = data.durations.reduce((a, b) => a + b, 0) / data.durations.length;

            const nextStates = Array.from(data.transitions.entries()).map(([toEvent, transData]) => {
                const transAvg = transData.durations.reduce((a, b) => a + b, 0) / transData.durations.length;
                return {
                    event: toEvent,
                    probability: transData.count / data.total,
                    avgDuration: Math.round(transAvg)
                };
            }).sort((a, b) => b.probability - a.probability);

            return {
                event: fromEvent,
                totalOccurrences: data.total,
                avgDuration: Math.round(avgDuration),
                nextStates
            };
        }).sort((a, b) => b.totalOccurrences - a.totalOccurrences);
    }

}

// MetricsCalculator - computes performance metrics and analysis
class MetricsCalculator {
    constructor(eventStore, patternDetection) {
        this.store = eventStore;
        this.patterns = patternDetection;
    }

    getMetrics() {
        const recentEvents = this.store.events.slice(-CONFIG.debug.analysis.recentWindowSize);
        const recentErrors = Array.from(this.store.errors.values()).slice(-CONFIG.debug.analysis.errorWindowSize);

        return {
            eventRate: this.calculateEventRate(recentEvents),
            errorRate: this.calculateErrorRate(recentErrors),
            memoryPressure: this.calculateMemoryPressure(),
            performanceBottlenecks: this.identifyBottlenecks(),
            taskSuccess: this.calculateTaskSuccessRate()
        };
    }

    getPerformanceProfile() {
        const profiles = new Map();

        for (const [label, data] of this.store.performanceMarks) {
            const category = this.categorizeOperation(label);
            if (!profiles.has(category)) {
                profiles.set(category, { count: 0, totalTime: 0, totalMemory: 0, operations: [] });
            }
            const profile = profiles.get(category);
            profile.count++;
            profile.totalTime += data.duration;
            profile.totalMemory += data.memDelta;
            profile.operations.push({ label, ...data });
        }

        return Array.from(profiles.entries()).map(([category, data]) => ({
            category,
            avgTime: data.totalTime / data.count,
            avgMemory: data.totalMemory / data.count,
            ...data
        }));
    }

    getCriticalPath() {
        const paths = [];

       
        for (const [errorId, errorData] of this.store.errors) {
            const chain = errorData.causalChain;
            if (!chain || chain.length === 0) continue;
            const duration = chain.length > 1 ? chain[chain.length - 1].timestamp - chain[0].timestamp : 0;
            paths.push({
                errorId,
                duration,
                steps: chain.length,
                path: chain.map(e => e.event)
            });
        }

       
        return paths.sort((a, b) => b.duration - a.duration).slice(0, CONFIG.debug.analysis.topResultsLimit);
    }

    detectPatterns() {
        const patterns = {
            memoryLeaks: this.patterns.detectMemoryLeaks(),
            performanceDegradation: this.patterns.detectPerformanceDegradation(),
            errorClusters: this.patterns.detectErrorClusters(),
            resourceSpikes: this.patterns.detectResourceSpikes()
        };

        return patterns;
    }

    calculateEventRate(events) {
        if (events.length < 2) return 0;
        const timeSpan = events[events.length - 1].timestamp - events[0].timestamp;
        return timeSpan > 0 ? (events.length / timeSpan) * CONFIG.core.time.msPerSecond : 0;
    }

    calculateErrorRate(errors) {
        if (errors.length === 0) return 0;
        const timeSpan = Date.now() - errors[0].timestamp;
        return timeSpan > 0 ? (errors.length / timeSpan) * CONFIG.core.time.msPerSecond : 0;
    }

    calculateMemoryPressure() {
        const mem = process.memoryUsage();
        return mem.heapUsed / mem.heapTotal;
    }

    identifyBottlenecks() {
        const slowOps = [];
        for (const [label, data] of this.store.performanceMarks) {
            if (data.duration > CONFIG.debug.performanceWarnThreshold) {
                slowOps.push({ operation: label, label, duration: data.duration, avgDuration: data.duration });
            }
        }
        return slowOps.sort((a, b) => b.duration - a.duration).slice(0, CONFIG.debug.analysis.topResultsLimit);
    }

    calculateTaskSuccessRate() {
        const taskEvents = this.store.events.filter(e => e.event.includes(CONFIG.strings.operationCategories[CONFIG.strings.operationCategories.length - 1]));
        const errorEvents = Array.from(this.store.errors.values());

        if (taskEvents.length === 0) return 1;
        const failureCount = errorEvents.filter(e => e.context.task).length;
        return 1 - (failureCount / taskEvents.length);
    }

    categorizeOperation(label) {
        for (const category of CONFIG.strings.operationCategories) {
            if (label.includes(category)) return category;
        }
        return CONFIG.strings.defaultCategory;
    }
}

// PatternDetection - detects anomalies and patterns in event streams
class PatternDetection {
    constructor(eventStore) {
        this.store = eventStore;
    }

    detectMemoryLeaks() {
        const memoryTrend = this.store.events.slice(-CONFIG.debug.analysis.memoryTrendSize).map(e => e.memory.heapUsed);
        if (memoryTrend.length < CONFIG.process.lockRetryAttempts) return false;

       
        const n = memoryTrend.length;
        const indices = Array.from({ length: n }, (_, i) => i);
        const sumX = indices.reduce((a, b) => a + b, 0);
        const sumY = memoryTrend.reduce((a, b) => a + b, 0);
        const sumXY = indices.reduce((sum, x, i) => sum + x * memoryTrend[i], 0);
        const sumX2 = indices.reduce((sum, x) => sum + x * x, 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        return slope > THRESHOLDS.MEMORY_LEAK_SLOPE;
    }

    detectPerformanceDegradation() {
        const recent = Array.from(this.store.performanceMarks.values()).slice(-CONFIG.debug.analysis.performanceSampleSize);
        if (recent.length < CONFIG.process.lockRetryAttempts) return false;

        const halfPoint = Math.floor(recent.length / 2);
        const firstHalf = recent.slice(0, halfPoint);
        const secondHalf = recent.slice(halfPoint);

        const avgFirst = firstHalf.reduce((sum, d) => sum + d.duration, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((sum, d) => sum + d.duration, 0) / secondHalf.length;

        return avgSecond > avgFirst * 2;
    }

    detectErrorClusters() {
        const errors = Array.from(this.store.errors.values());
        if (errors.length < CONFIG.processor.minGroupSize) return [];

        const clusters = [];
        let currentCluster = [errors[0]];

        for (let i = 1; i < errors.length; i++) {
            const timeDiff = errors[i].timestamp - errors[i - 1].timestamp;
            if (timeDiff < THRESHOLDS.ERROR_CLUSTER_WINDOW) {
                currentCluster.push(errors[i]);
            } else {
                if (currentCluster.length >= CONFIG.processor.minGroupSize) {
                    clusters.push(currentCluster);
                }
                currentCluster = [errors[i]];
            }
        }

        if (currentCluster.length >= CONFIG.processor.minGroupSize) {
            clusters.push(currentCluster);
        }

        return clusters;
    }

    detectResourceSpikes() {
        const spikes = [];
        const memoryData = this.store.events.map(e => ({ timestamp: e.timestamp, heap: e.memory.heapUsed }));

        for (let i = 1; i < memoryData.length; i++) {
            const delta = memoryData[i].heap - memoryData[i - 1].heap;
            if (delta > BINARY.MB * THRESHOLDS.MEMORY_SPIKE_MB) {
                spikes.push({
                    timestamp: memoryData[i].timestamp,
                    delta,
                    event: this.store.events[i].event
                });
            }
        }

        return spikes;
    }
}

// TelemetryExporter - exports metrics in various formats (Prometheus, Datadog, JSON)
class TelemetryExporter {
    constructor(orchestrator) {
        this.orchestrator = orchestrator;
        this.lazyTelemetry = null;
    }

    initializeLazyTelemetry() {
        this.lazyTelemetry = new Lazy(() => ({
            metrics: new Lazy(() => this.orchestrator.getMetrics()),
            profile: new Lazy(() => this.orchestrator.getPerformanceProfile()),
            patterns: new Lazy(() => this.orchestrator.detectPatterns()),
            system: new Lazy(() => ({
                memory: process.memoryUsage(),
                cpu: process.cpuUsage(),
                platform: process.platform,
                nodeVersion: process.version,
                pid: process.pid,
                uptime: this.orchestrator.events[0]?.timestamp ? Date.now() - this.orchestrator.events[0].timestamp : undefined
            })),
            events: new Lazy(() => {
                const now = Date.now();
                return {
                    total: this.orchestrator.events.length,
                    rate: this.orchestrator.calculateEventRate(this.orchestrator.events),
                    recentCount: this.orchestrator.events.filter(e => now - e.timestamp < TIME.VERY_LONG).length,
                    oldestTimestamp: this.orchestrator.events[0]?.timestamp,
                    newestTimestamp: this.orchestrator.events[this.orchestrator.events.length - 1]?.timestamp,
                    recent: new LazyStream(
                        this.orchestrator.events[this.orchestrator.events.length - 1],
                        () => this.orchestrator.events.length > 1
                            ? new LazyStream(this.orchestrator.events[this.orchestrator.events.length - 2], null)
                            : null
                    )
                };
            }),
            errors: new Lazy(() => ({
                total: this.orchestrator.errors.size,
                rate: this.orchestrator.calculateErrorRate(Array.from(this.orchestrator.errors.values())),
                recent: new Lazy(() =>
                    Array.from(this.orchestrator.errors.values())
                        .filter(e => Date.now() - e.timestamp < TIME.VERY_LONG)
                        .map(e => ({
                            message: e.error.message,
                            timestamp: e.timestamp,
                            context: e.context,
                            chainLength: e.causalChain.length
                        }))
                ),
                clusters: new Lazy(() =>
                    this.orchestrator.detectErrorClusters().map(cluster => ({
                        size: cluster.length,
                        startTime: cluster[0].timestamp,
                        endTime: cluster[cluster.length - 1].timestamp,
                        types: [...new Set(cluster.map(e => e.error.message.split(':')[0]))]
                    }))
                )
            })),
            performance: new Lazy(() => ({
                marks: this.orchestrator.performanceMarks.size,
                profile: new Lazy(() => this.orchestrator.getPerformanceProfile()),
                bottlenecks: new Lazy(() => this.orchestrator.identifyBottlenecks()),
                criticalPaths: new Lazy(() => this.orchestrator.getCriticalPath()),
                slowestOperations: new Lazy(() =>
                    Array.from(this.orchestrator.performanceMarks.entries())
                        .sort((a, b) => b[1].duration - a[1].duration)
                        .slice(0, THRESHOLDS.TOP_RESULTS)
                        .map(([label, data]) => ({
                            label,
                            duration: data.duration,
                            memory: data.memDelta,
                            timestamp: data.timestamp
                        }))
                )
            })),
            causality: new Lazy(() => ({
                chains: this.orchestrator.causality.size,
                maxChainLength: new Lazy(() =>
                    Math.max(...Array.from(this.orchestrator.causality.values()).map(c => c.length), 0)
                ),
                orphanEvents: new Lazy(() =>
                    this.orchestrator.events.filter(e => !e.parent && !this.orchestrator.causality.has(e.id)).length
                )
            })),
            processor: new Lazy(() =>
                (typeof processor !== 'undefined' && processor?.state) ? {
                    browser: processor.state.browser !== null,
                    pages: processor.state.pages.size,
                    hashes: processor.state.hashes.size,
                    building: processor.state.building.size,
                    errors: processor.state.errors.length,
                    builds: processor.state.stats.builds,
                    uptime: Date.now() - processor.state.stats.uptime
                } : null
            ),
            export: new Lazy(() => {
                const timestamp = Date.now();
                const data = LazyFunctor.extract({
                    timestamp,
                    system: this.lazyTelemetry.value.system,
                    events: this.lazyTelemetry.value.events,
                    errors: this.lazyTelemetry.value.errors,
                    performance: this.lazyTelemetry.value.performance,
                    causality: this.lazyTelemetry.value.causality,
                    patterns: this.lazyTelemetry.value.patterns,
                    metrics: this.lazyTelemetry.value.metrics,
                    processor: this.lazyTelemetry.value.processor
                });
                return {
                    timestamp,
                    data,
                    json: new Lazy(() => JSON.stringify(data, null, 2)),
                    metrics: new Lazy(() => this.formatMetrics(data)),
                    timeseries: new Lazy(() => this.formatTimeseries(data))
                };
            })
        }));
        return this.lazyTelemetry;
    }

    createTelemetryStream() {
        if (!this.lazyTelemetry) {
            this.initializeLazyTelemetry();
        }
        const telemetryStream = fix(stream =>
            new LazyStream(
                new Lazy(() => ({
                    timestamp: Date.now(),
                    snapshot: this.lazyTelemetry.value.export.value.data
                })),
                () => {
                    return new Lazy(() => {
                        return new PullPromise(async () => {
                            await new Promise(resolve =>
                                setTimeout(resolve, CONFIG.watcher.interval)
                            );
                            return stream.value;
                        });
                    });
                }
            )
        );
        telemetryStream.deltaMetrics = new Lazy(() => telemetryStream.value
            .window(2)
            .map(window => {
                if (window.length < 2) return null;
                const [prev, curr] = window;
                return {
                    timestamp: curr.timestamp,
                    timeDelta: curr.timestamp - prev.timestamp,
                    eventDelta: curr.snapshot.events.total - prev.snapshot.events.total,
                    errorDelta: curr.snapshot.errors.total - prev.snapshot.errors.total,
                    memoryDelta: curr.snapshot.system.memory.heapUsed - prev.snapshot.system.memory.heapUsed
                };
            })
            .filter(delta => delta !== null)
        );
        telemetryStream.anomalies = new Lazy(() => telemetryStream.value
            .map(snapshot => {
                const anomalies = [];
                if (snapshot.snapshot.errors.rate > LIMITS.RETRIES) {
                    anomalies.push({
                        type: 'HIGH_ERROR_RATE',
                        value: snapshot.snapshot.errors.rate,
                        timestamp: snapshot.timestamp
                    });
                }
                const memoryPressure = snapshot.snapshot.system.memory.heapUsed /
                                      snapshot.snapshot.system.memory.heapTotal;
                const threshold = CONFIG.core.limits.memoryPressureThreshold;
                if (memoryPressure > (threshold instanceof Lazy ? threshold.value : threshold)) {
                    anomalies.push({
                        type: 'HIGH_MEMORY_PRESSURE',
                        value: memoryPressure,
                        timestamp: snapshot.timestamp
                    });
                }
                const maxRate = CONFIG.core.limits.maxEventRate;
                if (snapshot.snapshot.events.rate > (maxRate instanceof Lazy ? maxRate.value : maxRate)) {
                    anomalies.push({
                        type: 'EVENT_SPIKE',
                        value: snapshot.snapshot.events.rate,
                        timestamp: snapshot.timestamp
                    });
                }
                return anomalies.length > 0 ? { timestamp: snapshot.timestamp, anomalies } : null;
            })
            .filter(anomaly => anomaly !== null)
        );
        telemetryStream.aggregates = new Lazy(() => telemetryStream.value
            .window(THRESHOLDS.AGGREGATE_WINDOW)
            .map(window => ({
                timestamp: Date.now(),
                windowSize: window.length,
                avgEventRate: window.reduce((sum, s) => sum + s.snapshot.events.rate, 0) / window.length,
                avgErrorRate: window.reduce((sum, s) => sum + s.snapshot.errors.rate, 0) / window.length,
                maxMemory: Math.max(...window.map(s => s.snapshot.system.memory.heapUsed)),
                minMemory: Math.min(...window.map(s => s.snapshot.system.memory.heapUsed))
            }))
        );
        return telemetryStream;
    }

    exportTelemetry() {
        if (!this.lazyTelemetry) {
            this.initializeLazyTelemetry();
        }
        const exported = this.lazyTelemetry.value.export.value;
        return {
            raw: exported.data,
            metrics: exported.metrics.value,
            timeseries: exported.timeseries.value,
            json: exported.json.value
        };
    }

    formatMetrics(telemetry) {
        const metrics = [];
        metrics.push(`# HELP hct_events_total Total number of events`);
        metrics.push(`# TYPE hct_events_total gauge`);
        metrics.push(`hct_events_total ${telemetry.events.total}`);
        metrics.push(`# HELP hct_events_rate Events per second`);
        metrics.push(`# TYPE hct_events_rate gauge`);
        metrics.push(`hct_events_rate ${telemetry.events.rate?.toFixed(2)}`);
        metrics.push(`# HELP hct_errors_total Total number of errors`);
        metrics.push(`# TYPE hct_errors_total counter`);
        metrics.push(`hct_errors_total ${telemetry.errors.total}`);
        metrics.push(`# HELP hct_memory_heap_used_bytes Heap memory used`);
        metrics.push(`# TYPE hct_memory_heap_used_bytes gauge`);
        metrics.push(`hct_memory_heap_used_bytes ${telemetry.system?.memory?.heapUsed}`);
        metrics.push(`# HELP hct_memory_pressure Memory pressure ratio`);
        metrics.push(`# TYPE hct_memory_pressure gauge`);
        metrics.push(`hct_memory_pressure ${telemetry.metrics.memoryPressure?.toFixed(3)}`);
        if (telemetry.performance?.profile) {
            telemetry.performance.profile.forEach(profile => {
                metrics.push(`# HELP hct_operation_duration_ms Operation duration by category`);
                metrics.push(`# TYPE hct_operation_duration_ms histogram`);
                metrics.push(`hct_operation_duration_ms{category="${profile.category}"} ${profile.avgTime?.toFixed(2)}`);
            });
        }
        if (telemetry.processor) {
            metrics.push(`# HELP hct_processor_builds_total Total builds completed`);
            metrics.push(`# TYPE hct_processor_builds_total counter`);
            metrics.push(`hct_processor_builds_total ${telemetry.processor.builds}`);
            metrics.push(`# HELP hct_processor_pages_open Number of browser pages open`);
            metrics.push(`# TYPE hct_processor_pages_open gauge`);
            metrics.push(`hct_processor_pages_open ${telemetry.processor.pages}`);
        }
        return metrics.join('\n');
    }

    formatTimeseries(telemetry) {
        const ts = Math.floor(telemetry.timestamp / TIME.SECOND);
        const tags = [`env:${process.env.NODE_ENV}`, `pid:${telemetry.system.pid}`];

        const series = [
            { metric: 'hct.events.total', points: [[ts, telemetry.events.total]], type: 'gauge', tags },
            { metric: 'hct.events.rate', points: [[ts, telemetry.events.rate]], type: 'gauge', tags },
            { metric: 'hct.errors.total', points: [[ts, telemetry.errors.total]], type: 'count', tags },
            { metric: 'hct.memory.heap.used', points: [[ts, telemetry.system.memory.heapUsed]], type: 'gauge', tags }
        ];

        if (telemetry.performance?.profile) {
            telemetry.performance.profile.forEach(p => {
                series.push({
                    metric: 'hct.operation.duration',
                    points: [[ts, p.avgTime]],
                    type: 'gauge',
                    tags: [...tags, `category:${p.category}`]
                });
            });
        }

        return { series };
    }
}

// InvariantChecker - verifies runtime properties over event traces
class InvariantChecker {
    constructor(eventStore) {
        this.store = eventStore;
    }

    checkInvariant(property, evidence) {
        const violations = [];
        for (const event of this.store.events) {
            if (!property(event, evidence)) {
                violations.push(event);
            }
        }
        return violations.length === 0 ? { holds: true } : { holds: false, violations };
    }

    checkHermetic(buildId) {
        const buildEvents = this.store.events.filter(e => e.context.buildId === buildId);
        const inputs = buildEvents.filter(e => e.event === 'INPUT_READ');
        const outputs = buildEvents.filter(e => e.event === 'OUTPUT_WRITE');
        const inputHashes = inputs.map(e => e.context.hash).sort().join(',');
        const outputHashes = outputs.map(e => e.context.hash).sort().join(',');
        const property = (otherBuildId) => {
            const otherBuildEvents = this.store.events.filter(e => e.context.buildId === otherBuildId);
            const otherInputs = otherBuildEvents.filter(e => e.event === 'INPUT_READ');
            const otherOutputs = otherBuildEvents.filter(e => e.event === 'OUTPUT_WRITE');
            const otherInputHashes = otherInputs.map(e => e.context.hash).sort().join(',');
            const otherOutputHashes = otherOutputs.map(e => e.context.hash).sort().join(',');
            return inputHashes === otherInputHashes ? outputHashes === otherOutputHashes : true;
        };
        const allBuilds = [...new Set(this.store.events.map(e => e.context.buildId))].filter(id => id && id !== buildId);
        const violations = allBuilds.filter(id => !property(id));
        return violations.length === 0 ? { hermetic: true } : { hermetic: false, violations };
    }

    checkCacheValid(cacheKey) {
        const cacheEvents = this.store.events.filter(e => e.context.cacheKey === cacheKey);
        if (cacheEvents.length === 0) return { valid: true, reason: 'no-cache-events' };
        const cacheWrite = cacheEvents.find(e => e.event === 'CACHE_WRITE');
        if (!cacheWrite) return { valid: false, reason: 'no-write-event' };
        const inputsAtWrite = cacheWrite.context.inputs;
        const currentInputModTimes = inputsAtWrite.map(input => ({
            file: input,
            mtime: this.store.events.filter(e => e.context.file === input && e.event === 'FILE_MODIFIED')
                .sort((a, b) => b.timestamp - a.timestamp)[0]?.timestamp
        }));
        const invalidInputs = currentInputModTimes.filter(i => i.mtime > cacheWrite.timestamp);
        return invalidInputs.length === 0 ? { valid: true } : { valid: false, invalidInputs };
    }

    checkIncremental(evidence) {
        const rebuilds = this.store.events.filter(e => e.event === 'BUILD_START');
        const violations = [];
        for (const rebuild of rebuilds) {
            const changedFiles = evidence.changedFiles;
            const builtFiles = this.store.events
                .filter(e => e.timestamp > rebuild.timestamp && e.event === 'FILE_BUILT')
                .map(e => e.context.file);
            const unnecessaryBuilds = builtFiles.filter(f => !changedFiles.includes(f));
            if (unnecessaryBuilds.length > 0) {
                violations.push({ rebuild: rebuild.id, unnecessary: unnecessaryBuilds });
            }
        }
        return violations.length === 0 ? { incremental: true } : { incremental: false, violations };
    }
}

// TraceOrchestrator - main class delegating to specialized components
class TraceOrchestrator {
    constructor() {
        this.store = new EventStore(CONFIG.debug.maxEvents, CONFIG.debug.maxMaps);
        this.causalAnalysis = new CausalAnalysis(this.store);
        this.patternDetection = new PatternDetection(this.store);
        this.metricsCalculator = new MetricsCalculator(this.store, this.patternDetection);
        this.telemetryExporter = new TelemetryExporter(this);
        this.invariantChecker = new InvariantChecker(this.store);


        this.events = this.store.events;
        this.errors = this.store.errors;
        this.causality = this.store.causality;
        this.stackTraces = this.store.stackTraces;
        this.performanceMarks = this.store.performanceMarks;
        this.runtimeViolations = this.store.runtimeViolations;
        this.violationsReported = this.store.violationsReported;
        this.maxEvents = this.store.maxEvents;
        this.maxMaps = this.store.maxMaps;
        this.currentContext = this.store.currentContext;


        this.lazyTelemetry = null;
        this.lastEventHash = null;

        this.setupPeriodicCleanup();
    }
    
    setupPeriodicCleanup() {
        const cleanup = new Lazy(() => {
            this.cleanupMaps();
            if (this.events.length > this.maxEvents) {
                this.events = this.events.slice(-this.maxEvents);
            }
           
            if (this.runtimeViolations.size > 0 && !this.violationsReported) {
                logger.error(`[RUNTIME] ${this.runtimeViolations.size} violations detected:`, 
                    Array.from(this.runtimeViolations));
                const reportToken = { resource: 'violations-report', instance: this };
                hasher.consumed.add(reportToken);
                hasher.linearResources.add('violations-report');
                this.violationsReported = true;
            }
            
            this.scheduleNextCleanup();
        });
        
        this.cleanupStream = new LazyStream(
            cleanup,
            () => this.cleanupStream
        );
        
        this.scheduleNextCleanup();
    }
    
    scheduleNextCleanup() {
        new PullPromise(async () => {
            await new Promise(resolve => {
                setTimeout(() => {
                    this.cleanupStream.head.value;
                    resolve();
                }, CONFIG.debug.cleanupInterval);
            });
        });
    }
    
    trace(event, context = {}) {
        const timestamp = Date.now();
        const stack = new Error().stack;
        const eventId = crypto.randomBytes(CONFIG.processor.hashLength).toString(CONFIG.strings.hashEncoding);
        

        if (hasher) {
            hasher.absorb({
                event,
                context,
                timestamp,
                eventId
            }, `trace-${eventId}`);

            const eventHmac = crypto.createHmac(CONFIG.strings.mainHashAlgorithm, HMAC_KEY);
            if (this.lastEventHash) {
                eventHmac.update(this.lastEventHash);
            }
            eventHmac.update(event);
            eventHmac.update(eventId.toString());
            eventHmac.update(timestamp.toString());
            const eventHash = eventHmac.digest(CONFIG.strings.hashEncoding);
            context.causalHash = eventHash;
            context.prevHash = this.lastEventHash;
            this.lastEventHash = eventHash;
        }
        
       
       
        if (context && typeof context === 'object' && configPatternValidator) {
            for (const [key, value] of Object.entries(context)) {
                if (key === 'duration' || key === 'timestamp' || key === 'memDelta' || key === 'causalHash') continue;
                if (configPatternValidator.detectMagicNumber(value, `${event}.${key}`)) {
                    this.runtimeViolations.add(`MAGIC_NUMBER: ${value} in ${event}.${key}`);
                }
            }
        }
        
        const tracedEvent = {
            id: eventId,
            event,
            context,
            timestamp,
            stack: stack.split('\n').slice(2, CONFIG.debug.stackFrameEnd),
            memory: process.memoryUsage(),
            parent: this.store.currentContext ? this.store.currentContext.id : null
        };

        this.store.append(tracedEvent);


        this.store.currentContext = tracedEvent;

        const message = this.formatEventMessage(event, context);
        if (message) {
            logger.log(message);
        }

        return eventId;
    }

    formatEventMessage(event, ctx) {
        switch(event) {
            case 'BUILD_START':
                return `[BUILD] ${ctx.name} from ${ctx.file}`;
            case 'BUILD_COMPLETE':
                return `[BUILD] ✓ ${ctx.name}: ${ctx.formats.join(', ')}`;
            case 'FS_READ':
                return `[FS] Reading ${path.basename(ctx.path)}`;
            case 'FS_WRITE':
                return `[FS] ✓ ${path.basename(ctx.path)}`;
            case 'BROWSER_LAUNCH':
                return `[PDF] Launching browser for ${ctx.name}`;
            case 'PAGE_CREATE':
                return `[PDF] Rendering page (attempt ${ctx.attempt})`;
            case 'PDF_GENERATED':
                return `[PDF] ✓ ${path.basename(ctx.path)}`;
            case 'PULL_GRAPH_COMPUTE':
                return `[GRAPH] Computing ${ctx.nodeId}`;
            case 'QUERY_CONNECTION':
                return `[QUERY] Client connected`;
            case 'INTEGRITY_CHECK':
                return `[VERIFY] ${ctx.match ? '✓' : '✗'} ${ctx.clientHash.slice(0,8)}`;
            case 'VEC_VALID':
            case 'LAZY_PATH':
                return null;
            default:
                return `[EVENT] ${event}`;
        }
    }

    explainFailure(eventId) {
        return this.causalAnalysis.explainFailure(eventId);
    }

    getNextEvents(eventId) {
        return this.causalAnalysis.getNextEvents(eventId);
    }

    getFailurePredictors() {
        return this.causalAnalysis.getFailurePredictors();
    }

    getTransitionMatrix() {
        return this.causalAnalysis.getTransitionMatrix();
    }

    cleanupMaps() {
        this.store.cleanup();
    }
    
    error(error, context = {}) {
        const errorId = this.trace(`ERROR: ${error.message}`, context);

        const causalChain = this.store.explainFailure(errorId);

        this.store.errors.set(errorId, {
            error,
            context,
            causalChain,
            timestamp: Date.now(),
            stack: error.stack
        });
        this.store.errorLRU = this.store.errorLRU.filter(k => k !== errorId);
        this.store.errorLRU.push(errorId);

        logger.error(`[ERROR ${errorId}] ${error.message}`);
        logger.error('Causal chain:', causalChain.map(e => `${e.event} (${e.timestamp})`).join(' -> '));

        return errorId;
    }

    explainFailure(eventId) {
        return this.store.explainFailure(eventId);
    }
    
    async performance(label, fn) {
        const start = performance.now();
        const startMem = process.memoryUsage();

        try {
            const result = await fn();
            const duration = performance.now() - start;
            const memDelta = process.memoryUsage().heapUsed - startMem.heapUsed;

            this.store.performanceMarks.set(label, { duration, memDelta, timestamp: Date.now() });
            this.store.performanceLRU = this.store.performanceLRU.filter(k => k !== label);
            this.store.performanceLRU.push(label);

            if (duration > CONFIG.debug.performanceWarnThreshold) {
                logger.warn(`[PERF] ${label} took ${duration.toFixed(2)}ms`);
            }

            return result;
        } catch (error) {
            this.error(error, { label, performance: true });
            throw error;
        }
    }
    
    getMetrics() {
        return this.metricsCalculator.getMetrics();
    }
    
    getPerformanceProfile() {
        return this.metricsCalculator.getPerformanceProfile();
    }
    
    getCriticalPath() {
        return this.metricsCalculator.getCriticalPath();
    }
    
    detectPatterns() {
        return this.metricsCalculator.detectPatterns();
    }

    calculateEventRate(events) {
        return this.metricsCalculator.calculateEventRate(events);
    }

    calculateErrorRate(errors) {
        return this.metricsCalculator.calculateErrorRate(errors);
    }

    calculateMemoryPressure() {
        return this.metricsCalculator.calculateMemoryPressure();
    }

    identifyBottlenecks() {
        return this.metricsCalculator.identifyBottlenecks();
    }

    calculateTaskSuccessRate() {
        return this.metricsCalculator.calculateTaskSuccessRate();
    }

    categorizeOperation(label) {
        return this.metricsCalculator.categorizeOperation(label);
    }

    detectMemoryLeaks() {
        return this.patternDetection.detectMemoryLeaks();
    }

    detectPerformanceDegradation() {
        return this.patternDetection.detectPerformanceDegradation();
    }

    detectErrorClusters() {
        return this.patternDetection.detectErrorClusters();
    }

    detectResourceSpikes() {
        return this.patternDetection.detectResourceSpikes();
    }

    categorizeOperation(label) {
        return this.metricsCalculator.categorizeOperation(label);
    }
    
    detectMemoryLeaks() {
        return this.patternDetection.detectMemoryLeaks();
    }
    
    detectPerformanceDegradation() {
        return this.patternDetection.detectPerformanceDegradation();
    }
    
    detectErrorClusters() {
        return this.patternDetection.detectErrorClusters();
    }
    
    detectResourceSpikes() {
        return this.patternDetection.detectResourceSpikes();
    }
    
   
    initializeLazyTelemetry() {
        this.lazyTelemetry = this.telemetryExporter.initializeLazyTelemetry();
        return this.lazyTelemetry;
    }
    createTelemetryStream() {
        return this.telemetryExporter.createTelemetryStream();
    }
    
    exportTelemetry() {
        return this.telemetryExporter.exportTelemetry();
    }
    
    formatMetrics(telemetry) {
        return this.telemetryExporter.formatMetrics(telemetry);
    }
    
    formatTimeseries(telemetry) {
        return this.telemetryExporter.formatTimeseries(telemetry);
    }
}

const stateSerializer = new StateSerializer();

// serializers for debug socket queries
stateSerializer.register('traceOrchestrator', (trace) => ({
    events: trace.events.length,
    violations: trace.runtimeViolations.size,
    metrics: trace.metricsCalculator ? trace.metricsCalculator.getMetrics() : {}
}));

// BUILD SCHEDULER

// Conflict Detector - Prevents double-processing of content regions
class ConflictDetector {
    constructor() {
        this.processedRegions = new Map();
        this.processingPaths = {
            documentPreprocess: ['<<<BLOCKMATH>>>', '<<<INLINEMATH>>>'],
            tokenizer: ['$', '\\(', '\\[', '_', 'colim_', 'lim_', 'f_*'],
            latexProcessor: ['<<<BLOCKMATH>>>', '<<<INLINEMATH>>>'],
            latexCommands: ['\\frac', '\\mathcal', '\\text', '\\bullet'],
            markdownProcessor: ['**', '*', '`', '['],
            symbolFallback: ['→', '←', '⇒', '∈', '∉']
        };
        this.processingOrder = [];
        this.conflicts = [];
    }

    shouldProcess(processor, content, pattern) {
        const lane = this.getProcessingLane(pattern);
        if (lane && !this.processingPaths[processor]?.includes(pattern)) {
            return false;
        }
        return this.claimProcessing(processor, content, pattern);
    }

    claimProcessing(processor, content, pattern) {
        const hash = this.hashContent(content);

        if (this.processedRegions.has(hash)) {
            const owner = this.processedRegions.get(hash);
            if (owner !== processor) {
                this.conflicts.push({
                    content,
                    pattern,
                    owner,
                    challenger: processor,
                    timestamp: Date.now()
                });

                traceOrchestrator.trace('PROCESSING_CONFLICT', {
                    content: content.substring(0, CONFIG.reporting.defaultDisplayLimit * CONFIG.performance.contentSnippetMultiplier),
                    owner,
                    challenger: processor
                });

                return false;
            }
        }

        this.processedRegions.set(hash, processor);
        this.processingOrder.push({ processor, pattern, timestamp: Date.now() });
        return true;
    }

    getProcessingLane(pattern) {
        for (const [lane, patterns] of Object.entries(this.processingPaths)) {
            if (patterns.some(p => pattern.includes(p))) {
                return lane;
            }
        }
        throw new Error(`No processing lane found for pattern: ${pattern}`);
    }

    hashContent(content) {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(16);
    }

    reset() {
        this.processedRegions.clear();
        this.processingOrder = [];
        this.conflicts = [];
    }

    getReport() {
        return {
            processed: this.processedRegions.size,
            order: this.processingOrder,
            conflicts: this.conflicts
        };
    }
}

const conflictDetector = new ConflictDetector();

class Hasher {
    constructor() {
        this.absorbed = [];
        this.state = new Map();
        this.capacity = new Map();
        this.rate = new Map();
        this.lastHash = null;
    }

    absorb(data, tag) {
       
       

        if (!this.absorbed) {
            this.absorbed = [];
        }

       
        const lazyData = data instanceof Lazy ? data : new Lazy(() => data);
        this.rate.set(tag, lazyData);
        this.absorbed.push({ data: lazyData, tag });

       
        const mixed = new Lazy(() => {
            const pulled = lazyData.value;
            const capacity = this.capacity.get('integrity')?.value;
            return { ...pulled, _capacity: capacity };
        });

        this.state.set(tag, mixed);
        return mixed;
    }

    contentHash(domain = 'content') {

        return new Lazy(() => {
            if (!this.absorbed || this.absorbed.length === 0) {
                throw new Error('No data absorbed yet');
            }


            const hasher = crypto.createHmac(CONFIG.strings.mainHashAlgorithm, HMAC_KEY);

            if (this.lastHash) {
                hasher.update(this.lastHash);
            }

            for (const item of this.absorbed) {
                const value = item.data.value;
                const serialized = typeof value === 'string' ? value : JSON.stringify(value);
                hasher.update(serialized);
                hasher.update(`|${item.tag}|`);
            }


            hasher.update(`|domain:${domain}|`);


            const hash = hasher.digest(CONFIG.strings.hashEncoding);
            this.lastHash = hash;

           
            if (pullGraph) {
                pullGraph.register(`${domain}-hash-${hash}`, new Lazy(() => this.absorbed));
            }

            if (traceOrchestrator) {
                traceOrchestrator.trace('CONTENT_HASH', { hash, absorbed: this.absorbed, domain });
            }

            return hash;
        });
    }

    verify(clientHash, serverHash) {
        const match = clientHash === serverHash;
        if (traceOrchestrator) {
            traceOrchestrator.trace('INTEGRITY_CHECK', {
                clientHash: clientHash.slice(0, 16),
                serverHash: serverHash.slice(0, 16),
                match
            });
        }
        return match;
    }

    buildHash(fileContent, fileName, buildContext) {

        this.absorbed = [];


        this.absorb(fileContent, 'file-content');


        this.absorb(fileName, 'file-name');
        this.absorb(buildContext.timestamp?.toString(), 'timestamp');
        this.absorb(buildContext.version, 'version');

       
        if (buildContext.gitCommit) {
            this.absorb(buildContext.gitCommit, 'git-commit');
        }

       
        if (buildContext.dependencies) {
            buildContext.dependencies.forEach(dep => {
                this.absorb(dep.hash, `dep-${dep.name}`);
            });
        }

       
        if (buildContext.formats) {
            buildContext.formats.forEach(fmt => this.absorb(fmt, `format-${fmt}`));
        }

       
        return this.contentHash('build');
    }
}

hasher = new Hasher();
traceOrchestrator = new TraceOrchestrator();

// DOCUMENT PROCESSOR

class DocumentProcessor {
    constructor() {
        this.sections = new Map();
        this.relationships = new Map();
        this.data = new Map();
        this.graph = initPullGraph();
        
       
        this.dependencies = ['LaTeXProcessor', 'ProcessingCoordinator'];
        this.provides = ['document-processing', 'section-management', 'relationship-tracking'];
        this.consumes = ['raw-text', 'latex-content'];
        this.lane = 'transform';
        this.linear = true; 
        this.mutex = ['LaTeXProcessor']; 
        this.orderingConstraints = {
            after: ['LaTeXProcessor'], 
            before: ['HTMLModality', 'PDFModality'] 
        };
        
       
        if (typeof hasher !== 'undefined' && hasher.registerSelf) {
            hasher.registerSelf(this);
        }
        
        this.modalities = {
            html: new HTMLModality(),
            pdf: new PDFModality(),
            markdown: new MarkdownModality()
        };
        
        this.context = ConfigContext.create();
        this.pipeline = null;
        
        this.state = {
            browser: null,
            pages: new Map(),
            hashes: new Map(),
            building: new Set(),
            errors: [],
            stats: { builds: 0, errors: 0, uptime: Date.now() }
        };
    }
    
    preprocessMathBlocks(text) {
       
        text = text.replace(/\\\{/g, '{');
        text = text.replace(/\\\}/g, '}');
        text = text.replace(/\\\\/g, '\\newline '); 

        text = text.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (match, content) => {
            return `<<<BLOCKMATH>>>${content.trim()}<<</BLOCKMATH>>>`;
        });

        text = text.replace(/\\\((.*?)\\\)/g, (match, content) => {
            return `<<<INLINEMATH>>>${content}<<</INLINEMATH>>>`;
        });

        return text;
    }
    
    parse(text) {
        return new Lazy(() => {
            this.sections.clear();
            this.relationships.clear();
            this.data.clear();

            this.parseEager(text);

            return { sections: this.sections, relationships: this.relationships };
        });
    }
    
    preprocessLazy(text) {
        return new Lazy(() => this.preprocessMathBlocks(text));
    }
    
    extractSectionsLazy(text) {
        return new Lazy(() => {
            const lines = text.split('\n');
            const sections = [];
            let currentSection = null;
            
            for (let i = 0; i < lines.length; i++) {
                const heading = this.detectHeading(lines[i], lines[i + 1]);
                if (heading) {
                    if (currentSection) {
                        sections.push(currentSection);
                    }
                    currentSection = {
                        level: heading.level,
                        title: heading.content,
                        content: [],
                        id: this.generateStableId(heading.content, sections.length)
                    };
                    if (heading.skip) i++;
                } else if (currentSection) {
                    currentSection.content.push(lines[i]);
                }
            }
            if (currentSection) sections.push(currentSection);
            
            sections.forEach(section => {
                this.sections.set(section.id, section);
                this.data.set(section.id, section.content.join('\n'));
            });
            
            return { sections, text };
        });
    }
    
    buildRelationshipsLazy(data) {
        return new Lazy(() => {
            const sections = data.sections;
            for (let i = 0; i < sections.length; i++) {
                const section = sections[i];
                if (i > 0) {
                    this.relationships.set(section.id + ':prev', sections[i - 1].id);
                }
                if (i < sections.length - 1) {
                    this.relationships.set(section.id + ':next', sections[i + 1].id);
                }
            }
            return data;
        });
    }

    parseEager(text) {
        this.sections.clear();
        this.relationships.clear();
        this.data.clear();

        text = this.preprocessMathBlocks(text);

        const lines = text.split('\n');
        let currentSection = null;
        let sectionStack = [];
        let sectionCounter = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const heading = this.detectHeading(line, lines[i + 1]);
            
            if (heading) {
                const id = this.generateStableId(heading.content, sectionCounter++);
                const section = {
                    id,
                    level: heading.level,
                    title: heading.content,
                    line: i,
                    children: [],
                    parent: null,
                    content: []
                };
                
                while (sectionStack.length > 0 && 
                       sectionStack[sectionStack.length - 1].level >= heading.level) {
                    sectionStack.pop();
                }
                
                if (sectionStack.length > 0) {
                    const parent = sectionStack[sectionStack.length - 1];
                    section.parent = parent.id;
                    parent.children.push(id);
                    
                    if (!this.relationships.has(parent.id)) {
                        this.relationships.set(parent.id, new Set());
                    }
                    this.relationships.get(parent.id).add(id);
                }
                
                this.sections.set(id, section);
                sectionStack.push(section);
                currentSection = section;
                
                if (heading.skip) i++;
            } else if (currentSection) {
                currentSection.content.push(line);
            }
        }

        for (const [id, section] of this.sections) {
            this.data.set(id, this.parseContent(section.content));
        }

        return this;
    }
    
    generateStableId(title, counter) {
        try {
            checkType(title, NonEmptyString);
        } catch (e) {
            throw new Error(`Invalid section title for ID generation (counter ${counter}): ${e.message}`);
        }
        
        const semantic = title.toLowerCase()
            .replace(CONFIG.patterns.nonWordChars, '')
            .replace(CONFIG.patterns.multiSpace, '-')
            .replace(CONFIG.patterns.multiDash, '-')
            .replace(CONFIG.patterns.trimDash, '');

        return `${CONFIG.strings.sectionIdPrefix}${counter}-${semantic}`.substring(0, CONFIG.processor.sectionIdMaxLength);
    }
    
    detectHeading(line, nextLine) {
       
        const hashMatch = line.match(CONFIG.patterns.hashHeading);
        if (hashMatch) {
            return {
                level: hashMatch[1].length,
                content: hashMatch[2].trim(),
                skip: false
            };
        }
        
       
        if (nextLine && line.trim()) {
            if (CONFIG.patterns.setextPrimary.test(nextLine.trim()) && nextLine.trim().length >= CONFIG.processor.minGroupSize) {
                return {
                    level: 1,
                    content: line.trim(),
                    skip: true
                };
            }
            if (CONFIG.patterns.setextSecondary.test(nextLine.trim()) && nextLine.trim().length >= CONFIG.processor.minGroupSize) {
                return {
                    level: CONFIG.processor.majorSectionLevel,
                    content: line.trim(),
                    skip: true
                };
            }
        }
        
       
        if (CONFIG.patterns.layerOrSection.test(line)) {
            return {
                level: CONFIG.processor.majorSectionLevel,
                content: line.trim(),
                skip: false
            };
        }
        
        return null;
    }
    
    parseContent(lines) {
        const blocks = [];
        let codeBlock = null;
        let mathBlock = null;
        
        for (const line of lines) {
           
            if (line.startsWith(CONFIG.strings.codeDelimiter)) {
                if (codeBlock) {
                    blocks.push({
                        type: 'code',
                        language: codeBlock.language,
                        content: codeBlock.lines.join('\n')
                    });
                    codeBlock = null;
                } else {
                    const lang = line.slice(CONFIG.processor.codeBlockSliceLength).trim();
                   
                    const validLangs = CONFIG.strings.supportedLanguages;
                    codeBlock = {
                        language: validLangs.includes(lang) ? lang : CONFIG.strings.defaultLanguage,
                        lines: []
                    };
                }
                continue;
            }
            
            if (codeBlock) {
                codeBlock.lines.push(line);
                continue;
            }
            
           
            if (line.includes(CONFIG.strings.mathStartDelimiter)) {
                if (/<<<BLOCKMATH>>>.+?<<<\/BLOCKMATH>>>/.test(line)) {
                   
                    blocks.push({
                        type: 'paragraph',
                        content: line
                    });
                } else {
                   
                    mathBlock = {
                        lines: [line]
                    };
                }
                continue;
            }
            
            if (mathBlock) {
                mathBlock.lines.push(line);
               
                if (line.includes(CONFIG.strings.mathEndDelimiter)) {
                    blocks.push({
                        type: 'paragraph',
                        content: mathBlock.lines.join('\n')
                    });
                    mathBlock = null;
                }
                continue;
            }
            
            const block = this.classifyBlock(line);
            blocks.push(block);
        }
        
        return blocks;
    }
    
    classifyBlock(line) {
        if (CONFIG.patterns.unorderedList.test(line)) {
            return {
                type: 'list-item',
                ordered: false,
                content: line.replace(CONFIG.patterns.unorderedList, ''),
                indent: line.search(/\S/)
            };
        }
        if (CONFIG.patterns.orderedList.test(line)) {
            return {
                type: 'list-item',
                ordered: true,
                content: line.replace(CONFIG.patterns.orderedList, ''),
                indent: line.search(/\S/)
            };
        }
        
        if (line.startsWith(CONFIG.strings.quoteDelimiter)) {
            return {
                type: 'blockquote',
                content: line.slice(1).trim()
            };
        }
        
        if (CONFIG.patterns.horizontalRule.test(line.trim())) {
            return { type: 'hr' };
        }
        
        if (!line.trim()) {
            return { type: 'blank' };
        }
        
        return {
            type: 'paragraph',
            content: line
        };
    }

   
    getCacheKey() {
       
        const contentParts = [];
        for (const [id, section] of this.sections) {
            const content = this.data.get(id);
            if (content) {
                contentParts.push(`${id}:${JSON.stringify(content)}`);
            }
        }
        const fullContent = contentParts.join('|');
        return crypto.createHash(CONFIG.strings.fallbackHashAlgorithm).update(fullContent).digest(CONFIG.strings.hashEncoding);
    }
    
    generateTOC() {
        const toc = [];
        const stack = [];
        
        for (const [id, section] of this.sections) {
           
            if (section.level > CONFIG.processor.tocMaxDepth) continue;
            
            const entry = {
                id,
                title: section.title,
                level: section.level,
                children: []
            };
            
           
            for (const [subId, subSection] of this.sections) {
                if (subSection.parent === id && subSection.level === CONFIG.processor.subSectionLevel) {
                    entry.children.push({
                        id: subId,
                        title: subSection.title,
                        level: subSection.level,
                        children: []
                    });
                }
            }
            
            while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) {
                stack.pop();
            }
            
            if (stack.length === 0) {
                toc.push(entry);
            } else {
                stack[stack.length - 1].children.push(entry);
            }
            
            stack.push(entry);
        }
        
        return toc;
    }
}

// LATEX PROCESSING

class LaTeXProcessor {
    constructor() {
        this.patterns = this.buildPatterns();
    }
    
    buildPatterns() {
        return {
            blockMath: [
                [/\$\$([^$]+?)\$\$/gm, (match, tex) => this.renderBlockMath(tex)],
                [/\\\[([\s\S]+?)\\\]/gm, (match, tex) => this.renderBlockMath(tex)],
                [/\\begin\{equation\}([\s\S]+?)\\end\{equation\}/gm, (match, tex) => this.renderBlockMath(tex)],
                [/\\begin\{align\}([\s\S]+?)\\end\{align\}/gm, (match, tex) => this.renderBlockMath(tex)],
            ],

            inlineMath: [
                [/\$([^$]+?)\$/g, (match, tex) => this.renderInlineMath(tex)],
                [/\\\(([^)]+?)\\\)/g, (match, tex) => this.renderInlineMath(tex)],
                [/\\text\{([^}]+)\}/g, (match, text) => `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.textInsideClass}">${text}</${CONFIG.strings.inlineElement}>`],
            ],
            
           
            commands: {
               
                'alpha': 'α', 'beta': 'β', 'gamma': 'γ', 'delta': 'δ', 'epsilon': 'ε',
                'zeta': 'ζ', 'eta': 'η', 'theta': 'θ', 'iota': 'ι', 'kappa': 'κ',
                'lambda': 'λ', 'mu': 'μ', 'nu': 'ν', 'xi': 'ξ', 'pi': 'π',
                'rho': 'ρ', 'sigma': 'σ', 'tau': 'τ', 'upsilon': 'υ', 'phi': 'φ',
                'chi': 'χ', 'psi': 'ψ', 'omega': 'ω',
                
               
                'Gamma': 'Γ', 'Delta': 'Δ', 'Theta': 'Θ', 'Lambda': 'Λ', 'Xi': 'Ξ',
                'Pi': 'Π', 'Sigma': 'Σ', 'Upsilon': 'Υ', 'Phi': 'Φ', 'Psi': 'Ψ', 'Omega': 'Ω',
                
               
                'times': '×', 'div': '÷', 'pm': '±', 'mp': '∓', 'cdot': '·', 
                'circ': '∘', 'bullet': '•', 'star': '⋆', 'ast': '∗',
                'oplus': '⊕', 'otimes': '⊗', 'ominus': '⊖', 'oslash': '⊘',
                'odot': '⊙', 'wedge': '∧', 'vee': '∨',
                
               
                'to': '→', 'rightarrow': '→', 'leftarrow': '←', 'leftrightarrow': '↔',
                'Rightarrow': '⇒', 'Leftarrow': '⇐', 'Leftrightarrow': '⇔',
                'mapsto': '↦', 'hookrightarrow': '↪', 'rightharpoonup': '⇀',
                'rightharpoondown': '⇁', 'rightleftarrows': '⇄',
                'leftrightarrows': '⇆', 'rightrightarrows': '⇉',
                'dashv': '⊣', 'vdash': '⊢',
                
               
                'leq': '≤', 'geq': '≥', 'neq': '≠', 'sim': '∼', 'simeq': '≃',
                'cong': '≅', 'equiv': '≡', 'approx': '≈', 'propto': '∝',
                'subset': '⊂', 'supset': '⊃', 'subseteq': '⊆', 'supseteq': '⊇',
                'asymp': '≍', 'preceq': '⪯', 'succeq': '⪰',
                'in': '∈', 'notin': '∉', 'ni': '∋',
                
               
                'forall': '∀', 'exists': '∃', 'nexists': '∄', 'neg': '¬', 'lnot': '¬',
                'land': '∧', 'lor': '∨', 'implies': '⇒', 'iff': '⇔',
                
               
                'emptyset': '∅', 'varnothing': '∅', 'cup': '∪', 'cap': '∩',
                'setminus': '∖', 'complement': '∁',
                
               
                'infty': '∞', 'partial': '∂', 'nabla': '∇', 'square': '□',
                'triangle': '△', 'angle': '∠', 'perp': '⊥', 'parallel': '∥',
                
               
                'op': '^{op}', 'co': '^{co}',
                
               
                'ldots': '…', 'cdots': '⋯', 'vdots': '⋮', 'ddots': '⋱',
            }
        };
    }
    
    process(text) {
        if (!text) return '';
        
       
        const codeBlocks = [];
        let result = text.replace(/```[\s\S]*?```/g, (match) => {
            codeBlocks.push(match);
            return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
        });
        
       
        result = result.replace(/<<<BLOCKMATH>>>(.+?)<<<\/BLOCKMATH>>>/gs, (m, content) => {
            if (conflictDetector.shouldProcess('latexProcessor', content, '<<<BLOCKMATH>>>')) {
                return this.renderBlockMath(content);
            }
            return m;
        });
        
        result = result.replace(/<<<INLINEMATH>>>(.+?)<<<\/INLINEMATH>>>/g, (m, content) => {
            if (conflictDetector.shouldProcess('latexProcessor', content, '<<<INLINEMATH>>>')) {
                return this.renderInlineMath(content);
            }
            return m;
        });

       
        result = result.replace(/(\s|^)(→|←|⇒|⇐|↔|⇔|↦|∈|∉|⊂|⊃|⊆|⊇|≤|≥|≠|∼|≃|≅|≡|≈)(\s|$)/g, '$1$2$3');
        
       
        codeBlocks.forEach((block, i) => {
            result = result.replace(`__CODE_BLOCK_${i}__`, block);
        });
        
        return result;
    }
    
    renderBlockMath(tex) {
        const processed = this.processTeX(tex);
        return `<${CONFIG.strings.blockElement} class="${CONFIG.strings.blockContentClass}">${processed}</${CONFIG.strings.blockElement}>`;
    }
    
    renderInlineMath(tex) {
        const processed = this.processTeX(tex);
        return `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.inlineContentClass}">${processed}</${CONFIG.strings.inlineElement}>`;
    }
    
    processTeX(tex, context = null) {
        if (!tex) return '';
        let result = tex.trim();

       
       
        if (!context) {
            context = {
                depth: 0,
                stack: [],
                cache: new Map(),
                transforms: new Map()
            };
        }

       
        const cacheKey = `${context.depth}:${tex}`;

       
        if (context.cache.has(cacheKey)) {
            return context.cache.get(cacheKey);
        }

       
        if (context.depth > CONFIG.latex.maxRecursionDepth) {
            logger.warn('Recursion depth exceeded:', tex.substring(0, CONFIG.latex.debugSubstringLength));
            return result;
        }

       
        context.stack.push({ input: tex, depth: context.depth });
        context.depth++;
        
        try {
            result = result.replace(/\\begin\{array\}(?:\{[^}]*\})?([\s\S]+?)\\end\{array\}/g, (match, content) => {
               
                const rows = content.trim().split(/(?:\\\\|\\newline)/g).filter(r => r.trim());
                const renderedRows = rows.map(row => {
                    const cells = row.split('&').map(cell => {
                        const processed = this.processTeX(cell.trim(), context);
                        return `<td class="array-cell">${processed}</td>`;
                    });
                    return `<tr>${cells.join('')}</tr>`;
                });
                return `<table class="array-math"><tbody>${renderedRows.join('')}</tbody></table>`;
            });

            result = result.replace(/\\begin\{aligned\}([\s\S]+?)\\end\{aligned\}/g, (match, content) => {
                const rows = content.trim().split('\\newline').filter(r => r.trim()).map(row => {
                   
                    const cells = row.split('&').map(cell => {
                        const processed = this.processTeX(cell.trim(), context);
                        return `<td class="align-cell">${processed}</td>`;
                    });
                    return `<tr>${cells.join('')}</tr>`;
                });
                return `<table class="aligned-math"><tbody>${rows.join('')}</tbody></table>`;
            });

        result = result.replace(/\\begin\{[bp]?matrix\}([\s\S]+?)\\end\{[bp]?matrix\}/g, (match, content) => {
            const rows = content.trim().split('\\\\').map(row =>
                row.split('&').map(cell => `<td>${this.processTeX(cell.trim(), context)}</td>`).join('')
            );
            return `<table class="matrix"><tbody>${rows.map(r => `<tr>${r}</tr>`).join('')}</tbody></table>`;
        });
        
        result = result.replace(CONFIG.patterns.operatorName, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.operatorClass}">$1</${CONFIG.strings.inlineElement}>`);
        
       
        result = result.replace(/\\(Disc|Codisc|Lan|Ran|colim|lim|Hom|Map|Fun|Cat|Set|Grp|Top|Sh|PSh|St|Un|Im|Re|Ker|Coker|cone|Tot|Spec|Proj|Ext|Tor|Desc|EX|EY)\b/g, 
            `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.operatorClass}">$1</${CONFIG.strings.inlineElement}>`);
        
       
        result = result.replace(/Čech/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.operatorClass}">Čech</${CONFIG.strings.inlineElement}>`);
        
       
        result = result.replace(/\\text\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.textInsideClass}">$1</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\mathrm\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.romanStyleClass}">$1</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\textbf\{([^}]+)\}/g, `<${CONFIG.strings.semanticElements.strong}>$1</${CONFIG.strings.semanticElements.strong}>`);
        result = result.replace(/\\textit\{([^}]+)\}/g, `<${CONFIG.strings.semanticElements.emphasis}>$1</${CONFIG.strings.semanticElements.emphasis}>`);
        
       
        result = result.replace(/\\mathcal\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.calligraphicClass}">$1</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\mathbb\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.blackboardClass}">$1</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\mathfrak\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.frakturClass}">$1</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\mathsf\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.sansSerifClass}">$1</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\mathbf\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.boldStyleClass}">$1</${CONFIG.strings.inlineElement}>`);
        
       
       
        result = result.replace(/\\xrightarrow\{([^}]+)\}/g, 
            `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.annotatedElementClass}">→<${CONFIG.strings.inlineElement} class="${CONFIG.strings.annotationTextClass}">$1</${CONFIG.strings.inlineElement}></${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\xleftarrow\{([^}]+)\}/g, 
            `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.annotatedElementClass}">←<${CONFIG.strings.inlineElement} class="${CONFIG.strings.annotationTextClass}">$1</${CONFIG.strings.inlineElement}></${CONFIG.strings.inlineElement}>`);
        
       
        result = result.replace(/\\tilde\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.tildeAccentClass}">$1ẽ</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\hat\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.hatAccentClass}">$1ê</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\bar\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.barAccentClass}">$1ē</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\dot\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.dotAccentClass}">$1ė</${CONFIG.strings.inlineElement}>`);
        result = result.replace(/\\vec\{([^}]+)\}/g, `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.vectorClass}">$1⃗</${CONFIG.strings.inlineElement}>`);
        
        let fractionIterations = 0;
        while (result.includes('\\frac{') && fractionIterations++ < THRESHOLDS.MAX_FRACTION_DEPTH) {
            result = result.replace(/\\frac\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
                (match, num, den) => {
                    const processedNum = this.escapeHtml(this.processTeX(num, context));
                    const processedDen = this.escapeHtml(this.processTeX(den, context));
                    return `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.fractionClass}"><${CONFIG.strings.inlineElement} class="${CONFIG.strings.numeratorClass}">${processedNum}</${CONFIG.strings.inlineElement}><${CONFIG.strings.inlineElement} class="${CONFIG.strings.denominatorClass}">${processedDen}</${CONFIG.strings.inlineElement}></${CONFIG.strings.inlineElement}>`;
                });
        }
        
       
       
        result = result.replace(/\^op\b/g, `<${CONFIG.strings.semanticElements.superscript}>op</${CONFIG.strings.semanticElements.superscript}>`);
        result = result.replace(/\^co\b/g, `<${CONFIG.strings.semanticElements.superscript}>co</${CONFIG.strings.semanticElements.superscript}>`);
        result = result.replace(/\^\*/g, `<${CONFIG.strings.semanticElements.superscript}>*</${CONFIG.strings.semanticElements.superscript}>`);
        result = result.replace(/\^\+/g, `<${CONFIG.strings.semanticElements.superscript}>+</${CONFIG.strings.semanticElements.superscript}>`);
        
       
       
        const processScript = (content, type) => {
            const oldDepth = context.depth;
            context.depth = Math.max(oldDepth - 1, 1);
            const processed = this.processTeX(content, context);
            context.depth = oldDepth;
            return type === CONFIG.strings.semanticElements.superscript ? `<${CONFIG.strings.semanticElements.superscript}>${processed}</${CONFIG.strings.semanticElements.superscript}>` : `<${CONFIG.strings.semanticElements.subscript}>${processed}</${CONFIG.strings.semanticElements.subscript}>`;
        };
        
       
        for (const [cmd, symbol] of Object.entries(this.patterns.commands)) {
            const regex = new RegExp(`\\\\${cmd}(?![a-zA-Z])`, 'g');
            result = result.replace(regex, symbol);
        }

        result = result.replace(/\^\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (match, content) => processScript(content, CONFIG.strings.semanticElements.superscript));
        result = result.replace(/_\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (match, content) => processScript(content, CONFIG.strings.semanticElements.subscript));
        
       
        result = result.replace(/\^([^\s\{\}])/g, `<${CONFIG.strings.semanticElements.superscript}>$1</${CONFIG.strings.semanticElements.superscript}>`);
        result = result.replace(/_([^\s\{\}])/g, `<${CONFIG.strings.semanticElements.subscript}>$1</${CONFIG.strings.semanticElements.subscript}>`)

       
        result = result.replace(/\\newline\s*/g, '<br>');

       
        result = result.replace(/\\setminus/g, '∖');
        result = result.replace(/\\backslash/g, '\\');
        result = result.replace(/\\partial/g, '∂');
        result = result.replace(/\\nabla/g, '∇');
        result = result.replace(/\\forall/g, '∀');
        result = result.replace(/\\exists/g, '∃');
        result = result.replace(/\\emptyset/g, '∅');
        result = result.replace(/\\in\b/g, '∈');
        result = result.replace(/\\notin\b/g, '∉');
        result = result.replace(/\\cup/g, '∪');
        result = result.replace(/\\cap/g, '∩');
        result = result.replace(/\\sqcup/g, '⊔');
        result = result.replace(/\\vee/g, '∨');
        result = result.replace(/\\wedge/g, '∧');
        result = result.replace(/\\neg/g, '¬');
        result = result.replace(/\\langle/g, '⟨');
        result = result.replace(/\\rangle/g, '⟩');
        result = result.replace(/\\lim/g, 'lim');
        result = result.replace(/\\varinjlim/g, 'colim');
        result = result.replace(/\\prod/g, '∏');
        result = result.replace(/\\coprod/g, '∐');
        result = result.replace(/\\sum/g, '∑');
        result = result.replace(/\\int/g, '∫');
        result = result.replace(/\\oint/g, '∮');
        result = result.replace(/\\dots/g, '…');
        result = result.replace(/\\cdots/g, '⋯');
        result = result.replace(/\\ldots/g, '…');
        result = result.replace(/\\ddots/g, '⋱');
        result = result.replace(/\\vdots/g, '⋮');
        result = result.replace(/\\quad/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
        result = result.replace(/\\qquad/g, '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;');
        result = result.replace(/\\,/g, '&nbsp;');
        result = result.replace(/\\ /g, '&nbsp;');
        result = result.replace(/\\;/g, '&nbsp;&nbsp;');
        result = result.replace(/\\!/g, '');
        result = result.replace(/\\longrightarrow/g, '⟶');
        result = result.replace(/\\downarrow/g, '↓');
        result = result.replace(/\\uparrow/g, '↑');
        result = result.replace(/\\natural/g, '♮');
        result = result.replace(/\\flat/g, '♭');
        result = result.replace(/\\sharp/g, '♯');
        result = result.replace(/\\heartsuit/g, '♥');
        
       
        result = result.replace(/->/g, '→');
        result = result.replace(/<-/g, '←');
        result = result.replace(/=>/g, '⇒');
        result = result.replace(/<=/g, '⇐');
        result = result.replace(/<=>/g, '⇔');
        result = result.replace(/\|->/g, '↦');
        
       
        result = result.replace(/(\w)\s*\\\s*(\w)/g, '$1 ∖ $2');
        
       
        result = result.replace(/\\([a-zA-Z]+)(?![{a-zA-Z])/g, (match, cmd) => {
           
            if (context.depth <= CONFIG.processor.topSectionLevel) {
            }
            return cmd;
        });

        } catch (error) {
            logger.error('LaTeX processing error at depth', context.depth, ':', error);
            result = tex;
        } finally {
           
            const stackFrame = context.stack.pop();

           
            if (stackFrame && result !== tex) {
                context.cache.set(cacheKey, result);

               
                if (!context.transforms.has(context.depth - 1)) {
                    context.transforms.set(context.depth - 1, new Map());
                }
                context.transforms.get(context.depth - 1).set(tex, result);
            }

           
            context.depth--;

           
            if (context.depth === 0) {
               
                context.cache.clear();
                context.transforms.clear();
                context.stack = [];
            }
        }

        return result;
    }
}

// HTML MODALITY

class HTMLModality {
    constructor() {
        this.latex = new LaTeXProcessor();
    }
    
    renderTOC(toc) {
        if (!toc || toc.length === 0) return '';
        
        return `
        <${CONFIG.strings.blockElement} class="${CONFIG.strings.navigationContentClass}">
            ${toc.map((entry, i) => this.renderTOCEntry(entry, i)).join('')}
        </${CONFIG.strings.blockElement}>`;
    }
    
    renderTOCEntry(entry) {
        const hasChildren = entry.children && entry.children.length > 0;
        const isNumbered = CONFIG.strings.structurePrefixes.some(prefix => entry.title.startsWith(prefix));
        const sectionNumber = isNumbered ? entry.title.match(/\d+/)?.[0] : '';
        const processedTitle = this.processTextToken(entry.title);

        return `
        <${CONFIG.strings.blockElement} class="${CONFIG.strings.navigationSectionClass} ${entry.level === CONFIG.processor.topLevel ? CONFIG.strings.navigationMajorClass : ''}">
            ${hasChildren ? `
                <button class="toc-toggle" onclick="toggleSection('toc-${entry.id}')" aria-expanded="false">
                    <${CONFIG.strings.inlineElement} class="${CONFIG.strings.toggleIconClass}">${CONFIG.strings.collapsedIndicator}</${CONFIG.strings.inlineElement}>
                </button>
            ` : `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.spacerClass}"></${CONFIG.strings.inlineElement}>`}
            <${CONFIG.strings.linkElement} href="#${entry.id}" class="${CONFIG.strings.navigationLinkClass}" data-section="${entry.id}" onclick="navigateToSection('${entry.id}', event)">
                ${sectionNumber ? `<${CONFIG.strings.inlineElement} class="${CONFIG.strings.navigationNumberClass}">${sectionNumber}</${CONFIG.strings.inlineElement}>` : ''}
                ${processedTitle}
            </${CONFIG.strings.linkElement}>
            ${hasChildren ? `
                <${CONFIG.strings.blockElement} class="${CONFIG.strings.childrenContainerClass}" id="toc-${entry.id}" style="display: ${CONFIG.css.display.none};">
                    ${entry.children.map((child, i) => this.renderTOCEntry(child, i)).join('')}
                </${CONFIG.strings.blockElement}>
            ` : ''}
        </${CONFIG.strings.blockElement}>`;
    }
    
    renderSection(section, content) {
        const processedTitle = this.processTextToken(section.title);
        const heading = `<h${section.level} id="${section.id}" class="${CONFIG.strings.sectionHeadingClass}">
            <${CONFIG.strings.linkElement} href="#${section.id}" class="${CONFIG.strings.anchorLinkClass}" onclick="navigateToSection('${section.id}', event)">${CONFIG.strings.anchorSymbol}</${CONFIG.strings.linkElement}>
            ${processedTitle}
        </h${section.level}>`;

        const blocks = this.renderBlocks(content);
        
       
        const linkedBlocks = this.addTOCLinks(blocks);
        
        return `<section class="${CONFIG.strings.documentSectionClass}" data-section-id="${section.id}">
            ${heading}
            ${linkedBlocks}
        </section>`;
    }
    
    addTOCLinks(html) {
       
        
       
        html = html.replace(
            /<li>([^<]+)<\/li>/g,
            (match, content) => {
               
               
               
               
               
               
                
               
                let prefix = '';
                let title = '';
                let fullTitle = content.trim();
                
               
                const sectionWithNum = /^(\d+\.\s*Section \d+:\s*)(.*)$/;
               
                const layerWithNum = /^(\d+\.\s*Layer \d+:\s*)(.*)$/;
               
                const sectionOnly = /^(Section \d+:\s*)(.*)$/;
               
                const layerOnly = /^(Layer \d+:\s*)(.*)$/;
               
                const numOnly = /^(\d+\.\s*)(.*)$/;
                
                let matched = false;
                
                if (sectionWithNum.test(fullTitle)) {
                    const m = fullTitle.match(sectionWithNum);
                    prefix = m[1];
                    title = m[2];
                    matched = true;
                } else if (layerWithNum.test(fullTitle)) {
                    const m = fullTitle.match(layerWithNum);
                    prefix = m[1];
                    title = m[2];
                    matched = true;
                } else if (sectionOnly.test(fullTitle)) {
                    const m = fullTitle.match(sectionOnly);
                    prefix = m[1];
                    title = m[2];
                    matched = true;
                } else if (layerOnly.test(fullTitle)) {
                    const m = fullTitle.match(layerOnly);
                    prefix = m[1];
                    title = m[2];
                    matched = true;
                } else if (numOnly.test(fullTitle)) {
                    const m = fullTitle.match(numOnly);
                    prefix = m[1];
                    title = m[2];
                    matched = true;
                }
                
                if (matched && title) {
                   
                    const sectionId = this.findSectionId(title);
                    if (!sectionId) {
                        throw new Error(`Section not found: ${title} or ${fullTitle}`);
                    }
                    
                    if (sectionId) {
                        return `<${CONFIG.strings.listItemElement}>${prefix}<${CONFIG.strings.linkElement} href="#${sectionId}" onclick="navigateToSection('${sectionId}', event)">${title}</${CONFIG.strings.linkElement}></${CONFIG.strings.listItemElement}>`;
                    }
                }
                
                return match;
            }
        );
        
        return html;
    }
    
    findSectionId(title) {
        if (!this.currentProcessor) {
            throw new Error('No current processor available for section lookup');
        }

        const cleanSearchTitle = title.trim().toLowerCase();
        const matches = [];

        for (const [id, section] of this.currentProcessor.sections) {
            const sectionTitle = section.title.toLowerCase();

            if (sectionTitle === cleanSearchTitle) {
                matches.push({ id, level: section.level, priority: 3 });
                continue;
            }

            const sectionWithoutPrefix = sectionTitle.replace(/^(?:section \d+:\s*|layer \d+:\s*|\d+\.\s*)/, '');
            const searchWithoutPrefix = cleanSearchTitle.replace(/^(?:section \d+:\s*|layer \d+:\s*|\d+\.\s*)/, '');

            if (sectionWithoutPrefix === searchWithoutPrefix) {
                matches.push({ id, level: section.level, priority: 2 });
                continue;
            }

            if (sectionTitle.includes(searchWithoutPrefix) || searchWithoutPrefix.includes(sectionWithoutPrefix)) {
                if (searchWithoutPrefix.length > CONFIG.latex.minMatchLength && sectionWithoutPrefix.length > CONFIG.latex.minMatchLength) {
                    matches.push({ id, level: section.level, priority: 1 });
                }
            }
        }

        if (matches.length === 0) {
            throw new Error(`No section found matching title: ${title}`);
        }

       
        matches.sort((a, b) => {
            if (b.priority !== a.priority) return b.priority - a.priority;
            return a.level - b.level;
        });

        return matches[0].id;
    }
    
    generateIdFromTitle(title) {
       
        const clean = title.toLowerCase()
            .replace(CONFIG.patterns.nonWordChars, '')
            .replace(CONFIG.patterns.multiSpace, '-')
            .replace(CONFIG.patterns.multiDash, '-')
            .replace(CONFIG.patterns.trimDash, '');
        return `${CONFIG.strings.sectionIdPrefix}${clean}`.substring(0, CONFIG.processor.sectionIdMaxLength);
    }
    
    isSectionTitle(title) {
       
        return title.length < CONFIG.processor.titleMaxLength && /^[A-Z]/.test(title.trim());
    }
    
    renderBlocks(blocks) {
        if (!blocks) return '';
        
        let html = [];
        let listStack = [];
        
        for (const block of blocks) {
            if (block.type !== 'list-item' && listStack.length > 0) {
                while (listStack.length > 0) {
                    const listType = listStack.pop();
                    html.push(`</${listType}>`);
                }
            }
            
            switch (block.type) {
                case 'paragraph':
                    const processed = this.processInline(block.content);
                    html.push(`<p>${processed}</p>`);
                    break;
                    
                case 'list-item':
                    const listType = block.ordered ? 'ol' : 'ul';
                    if (listStack.length === 0 || listStack[listStack.length - 1] !== listType) {
                        if (listStack.length > 0) {
                            html.push(`</${listStack.pop()}>`);
                        }
                        html.push(`<${listType}>`);
                        listStack.push(listType);
                    }
                    html.push(`<li>${this.processInline(block.content)}</li>`);
                    break;
                    
                case 'code':
                    html.push(`<pre><code class="language-${block.language}">${this.escapeHtml(block.content)}</code></pre>`);
                    break;
                    
                case 'blockquote':
                    html.push(`<blockquote>${this.processInline(block.content)}</blockquote>`);
                    break;
                    
                case 'hr':
                    html.push('<hr>');
                    break;
            }
        }
        
        while (listStack.length > 0) {
            html.push(`</${listStack.pop()}>`);
        }
        
        return html.join('\n');
    }
    
    processInline(text) {
        if (!text) return '';
        
       
       
       
       
        
        const tokens = this.tokenize(text);
        const processed = this.parseTokens(tokens);
        
       
       
        return this.processLatexInTokenizedContent(processed);
    }
    
    processLatexInTokenizedContent(html) {
       
       
        
        return html
           
            .replace(/<span class="math-inline">([^<]+)<\/span>/g, (fullMatch, tex) => {
                const processed = this.latex.processTeX(tex);
                return `<span class="math-inline">${processed}</span>`;
            })

            .replace(/<div class="math-block">([^<]+)<\/div>/g, (fullMatch, tex) => {
                const processed = this.latex.processTeX(tex);
                return `<div class="math-block">${processed}</div>`;
            });
    }
    
    tokenize(text) {
        const tokens = [];
        let pos = 0;
        
       
        conflictDetector.reset();
        
        while (pos < text.length) {
            let tokenFound = false;
            
           
            if (text.substr(pos, 15) === '<<<BLOCKMATH>>>') {
                const end = text.indexOf('<<</BLOCKMATH>>>', pos);
                if (end !== -1) {
                    const content = text.slice(pos + 15, end);
                    tokens.push({ type: 'blockmath', content: content });
                    pos = end + 16;
                    tokenFound = true;
                }
            } else if (text.substr(pos, 15) === '<<<INLINEMATH>>>') {
                const end = text.indexOf('<<</INLINEMATH>>>', pos);
                if (end !== -1) {
                    const content = text.slice(pos + 15, end);
                    tokens.push({ type: 'inlinemath', content: content });
                    pos = end + 17;
                    tokenFound = true;
                }
            }
            
           
            if (!tokenFound && text[pos] === '\\' && pos + 1 < text.length) {
                const next = text[pos + 1];
                
               
                if (next === '(' || next === '[') {
                    const closer = next === '(' ? '\\)' : '\\]';
                    const end = text.indexOf(closer, pos + 2);
                    if (end !== -1) {
                        const content = text.slice(pos, end + 2);
                       
                        if (conflictDetector.shouldProcess('tokenizer', content, '\\(')) {
                            tokens.push({ type: 'math', content: content });
                            pos = end + 2;
                            tokenFound = true;
                        }
                    }
                } else if (next === '$') {
                   
                    tokens.push({ type: 'text', content: '\\$' });
                    pos += 2;
                    tokenFound = true;
                } else if (/[a-zA-Z]/.test(next)) {
                   
                    let end = pos + 2;
                    while (end < text.length && /[a-zA-Z]/.test(text[end])) end++;
                    
                   
                    end = this.scanLatexArguments(text, end);
                    
                    tokens.push({ type: 'latex', content: text.slice(pos, end) });
                    pos = end;
                    tokenFound = true;
                }
            }
            
           
            if (!tokenFound && text[pos] === '$') {
                let end = pos + 1;
               
                while (end < text.length) {
                    if (text[end] === '$' && text[end - 1] !== '\\') {
                        tokens.push({ type: 'math', content: text.slice(pos, end + 1) });
                        pos = end + 1;
                        tokenFound = true;
                        break;
                    }
                    end++;
                }
                if (!tokenFound) {
                   
                    tokens.push({ type: 'text', content: '$' });
                    pos++;
                    tokenFound = true;
                }
            }
            
           
            if (!tokenFound && pos < text.length - 2) {
                const match = text.slice(pos).match(/^(colim|lim|hom|Hom|sup|inf|max|min)\b_/);
                if (match) {
                    let end = pos + match[1].length + 1;
                    const subscriptEnd = this.scanSubscriptOrSuperscript(text, end);
                    if (subscriptEnd > end) {
                        tokens.push({ type: 'latex', content: text.slice(pos, subscriptEnd) });
                        pos = subscriptEnd;
                        tokenFound = true;
                    }
                }
            }
            
           
            if (!tokenFound && pos + 1 < text.length && /[a-zA-Z]/.test(text[pos])) {
                const next = text[pos + 1];
                if (next === '_' || next === '^') {
                   
                    const isWordBoundary = pos === 0 || !/[a-zA-Z]/.test(text[pos - 1]);
                    if (isWordBoundary) {
                        let end = pos + 2;
                        const scriptEnd = this.scanSubscriptOrSuperscript(text, end);
                        if (scriptEnd > end) {
                            tokens.push({ type: 'latex', content: text.slice(pos, scriptEnd) });
                            pos = scriptEnd;
                            tokenFound = true;
                        }
                    }
                }
            }
            
           
            if (!tokenFound && text[pos] === '_') {
               
                if (pos + 1 < text.length && !(text[pos + 1] === '{' || text[pos + 1] === '*' || /[0-9]/.test(text[pos + 1]))) {
                    let end = pos + 1;
                    let mathDepth = 0;
                    
                   
                    while (end < text.length) {
                        if (text[end] === '_' && mathDepth === 0) {
                            tokens.push({ type: 'emphasis', content: text.slice(pos + 1, end) });
                            pos = end + 1;
                            tokenFound = true;
                            break;
                        }
                       
                        if (text[end] === '$' && text[end - 1] !== '\\') {
                            mathDepth = mathDepth === 0 ? 1 : 0;
                        } else if (text[end] === '\\' && end + 1 < text.length) {
                            if (text[end + 1] === '(') mathDepth++;
                            else if (text[end + 1] === ')' && mathDepth > 0) mathDepth--;
                        }
                        end++;
                    }
                }
            }
            
           
            if (!tokenFound) {
                let end = pos;
                
               
                while (end < text.length) {
                    const ch = text[end];
                    
                   
                    if (ch === '$' || ch === '\\' || ch === '_') {
                        break;
                    }
                    
                   
                    if (end + 1 < text.length && /[a-zA-Z]/.test(ch)) {
                        const next = text[end + 1];
                        if (next === '_' || next === '^') {
                            const isWordBoundary = end === 0 || !/[a-zA-Z]/.test(text[end - 1]);
                            if (isWordBoundary) break;
                        }
                    }
                    
                    end++;
                }
                
               
                if (end === pos) end = pos + 1;
                
                tokens.push({ type: 'text', content: text.slice(pos, end) });
                pos = end;
            }
        }
        
        return tokens;
    }
    
   
    scanLatexArguments(text, pos) {
        let end = pos;
        
        while (end < text.length && (text[end] === '_' || text[end] === '^' || text[end] === '{')) {
            if (text[end] === '{') {
               
                let braceDepth = 1;
                end++;
                while (end < text.length && braceDepth > 0) {
                    if (text[end] === '\\' && end + 1 < text.length) {
                       
                        end += 2;
                        continue;
                    }
                    if (text[end] === '{') braceDepth++;
                    else if (text[end] === '}') braceDepth--;
                    end++;
                }
            } else if (text[end] === '_' || text[end] === '^') {
               
                end++;
                end = this.scanSubscriptOrSuperscript(text, end);
            }
        }
        
        return end;
    }
    
   
    scanSubscriptOrSuperscript(text, pos) {
        if (pos >= text.length) return pos;
        
        if (text[pos] === '{') {
           
            let braceDepth = 1;
            let end = pos + 1;
            while (end < text.length && braceDepth > 0) {
                if (text[end] === '\\' && end + 1 < text.length) {
                   
                    end += 2;
                    continue;
                }
                if (text[end] === '{') braceDepth++;
                else if (text[end] === '}') braceDepth--;
                end++;
            }
            return end;
        } else if (text[pos] === '*' || /[0-9a-zA-Z]/.test(text[pos])) {
           
            return pos + 1;
        }
        
        return pos;
    }
    
    parseTokens(tokens) {
       
        let result = '';

       
        const mergedTokens = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            
            if (token.type === 'text' && mergedTokens.length > 0 && 
                mergedTokens[mergedTokens.length - 1].type === 'text') {
                mergedTokens[mergedTokens.length - 1].content += token.content;
            } else {
                mergedTokens.push({...token});
            }
        }
        
       
        for (const token of mergedTokens) {
            switch (token.type) {
                case 'blockmath':
                   
                    result += `<div class="math-block">${this.latex.processTeX(token.content)}</div>`;
                    break;
                    
                case 'inlinemath':
                   
                    result += `<span class="math-inline">${this.latex.processTeX(token.content)}</span>`;
                    break;
                    
                case 'math':
                   
                    if (token.content.startsWith('$$') || token.content.startsWith('\\[')) {
                       
                        const inner = token.content.replace(/^\$\$|\$\$$/g, '')
                                                   .replace(/^\\\[|\\\]$/g, '');
                        result += `<div class="math-block">${inner}</div>`;
                    } else {
                       
                        const inner = token.content.replace(/^\$|\$$/g, '')
                                                   .replace(/^\\\(|\\\)$/g, '');
                        result += `<span class="math-inline">${inner}</span>`;
                    }
                    break;
                    
                case 'latex':
                   
                    result += `<span class="math-inline">${token.content}</span>`;
                    break;
                    
                case 'emphasis':
                   
                    result += `<${CONFIG.strings.semanticElements.emphasis}>${token.content}</${CONFIG.strings.semanticElements.emphasis}>`;
                    break;
                    
                case 'text':
                   
                    result += this.processTextToken(token.content);
                    break;
            }
        }
        
        return result;
    }
    
    processTextToken(text) {
        let result = text;
        
       
        result = result.replace(/<<<BLOCKMATH>>>/g, '');
        result = result.replace(/<<<\/BLOCKMATH>>>/g, '');
        result = result.replace(/<<<INLINEMATH>>>/g, '');
        result = result.replace(/<<<\/INLINEMATH>>>/g, '');
        
       
        result = result.replace(/\*\*([^*]+)\*\*/g, 
            `<${CONFIG.strings.semanticElements.strong}>$1</${CONFIG.strings.semanticElements.strong}>`);
        
       
        result = result.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, 
            `<${CONFIG.strings.semanticElements.emphasis}>$1</${CONFIG.strings.semanticElements.emphasis}>`);
        
       
        result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
        
       
        result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        
        return result;
    }
    
    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
    
    generateHTML(processor) {
       
        this.currentProcessor = processor;
        
       
        return new Lazy(() => {
            const toc = processor.generateTOC();
            const tocHTML = this.renderTOC(toc);
            
            let sectionsHTML = [];
            for (const [id, section] of processor.sections) {
                const content = processor.data.get(id);
                sectionsHTML.push(this.renderSection(section, content));
            }
            
           
            const template = new LazyTemplate([
                '<!DOCTYPE html>\n',
                '<html lang="', CONFIG.strings.defaultLanguage, '">\n',
                '<head>\n',
                '    <meta charset="', CONFIG.strings.standardCharset, '">\n',
                '    <meta name="viewport" content="', CONFIG.strings.viewportContent, '">\n',
                '    <title>', CONFIG.strings.documentTitle, '</title>\n',
                '    <style>', this.generateCSS(), '</style>\n',
                '    <script>', this.generateJS(), '</script>\n',
                '</head>\n',
                '<body>\n',
                '    <nav class="', CONFIG.strings.sidebarClass, '">\n',
                '        <div class="', CONFIG.strings.headerClass, '">\n',
                '            <h2>', CONFIG.strings.contentsLabel, '</h2>\n',
                '            <button class="', CONFIG.strings.expandControlClass, '" onclick="expandAll()">', CONFIG.strings.expandAllLabel, '</button>\n',
                '        </div>\n',
                '        ', tocHTML, '\n',
                '    </nav>\n',
                '    <main class="', CONFIG.strings.contentClass, '">\n',
                '        ', sectionsHTML.join('\n'), '\n',
                '    </main>\n',
                '</body>\n',
                '</html>'
            ]);
            
           
            return template.toString();
        });
    }
    
    generateCSS() {
        return new Lazy(() => {
            const context = ConfigContext.create();
            
            const cssConfig = context.derive(env => ({
                colors: env.config.colors,
                ui: env.config.ui,
                css: env.config.css,
                strings: env.config.strings,
                common: env.common,
                zero: 0, one: 1, two: 2
            }));
            
            const template = new LazyTemplate([
                '/* Variables */\n',
                ':root {\n',
                '    --serif: \'Crimson Text\', Georgia, serif;\n',
                '    --sans: -apple-system, BlinkMacSystemFont, \'Segoe UI\', sans-serif;\n',
                '    --mono: \'SF Mono\', Monaco, monospace;\n',
                '    --text: ', CONFIG.colors.text.body, ';\n',
                '    --bg: ', CONFIG.colors.background.main, ';\n',
                '    --sidebar-bg: ', CONFIG.colors.background.sidebar, ';\n',
                '    --border: ', CONFIG.colors.border.default, ';\n',
                '    --link: ', CONFIG.colors.link.default, ';\n',
                '    --link-hover: ', CONFIG.colors.link.active, ';\n',
                '}\n\n',
                this.buildCSSRules(cssConfig)
            ]);
            
           
            return template.toString();
        });
    }
    
    buildCSSRules(context) {

        return Pipeline.compose(
            this.buildResetStyles.bind(this),
            this.buildBodyStyles.bind(this),
            this.buildParagraphStyles.bind(this),
            this.buildTOCStyles.bind(this),
            this.buildContentStyles.bind(this),
            this.buildMathStyles.bind(this),
            this.buildCodeStyles.bind(this),
            this.buildResponsiveStyles.bind(this),
            this.buildPrintStyles.bind(this)
        )(context);
    }
    
    buildResetStyles(context) {
        return new Lazy(() => new LazyTemplate([
            '* {\n',
            '    margin: 0;\n',
            '    padding: 0;\n',
            '    box-sizing: ', CONFIG.css.boxModel.border, ';\n',
            '}\n\n'
        ]));
    }
    
    buildBodyStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            'body {\n',
            '    font-family: var(--serif);\n',
            '    font-size: ', CONFIG.ui.typography.pixels.base, 'px;\n',
            '    line-height: ', CONFIG.ui.typography.lineHeight.relaxed, ';\n',
            '    color: var(--text);\n',
            '    display: ', CONFIG.css.display.flex, ';\n',
            '    min-height: ', THRESHOLDS.VIEWPORT_HEIGHT, 'vh;\n',
            '}\n\n'
        ]));
    }

    buildParagraphStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            'p {\n',
            '    margin-bottom: 1rem;\n',
            '}\n\n'
        ]));
    }

    buildTOCStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            '/* TOC Sidebar */\n',
            '.toc-sidebar {\n',
            '    width: ', CONFIG.ui.layout.sidebarWidth, 'px;\n',
            '    background: var(--sidebar-bg);\n',
            '    border-right: ', CONFIG.ui.borderWidth, 'px solid var(--border);\n',
            '    position: ', CONFIG.css.position.fixed, ';\n',
            '    top: 0;\n',
            '    left: 0;\n',
            '    height: ', THRESHOLDS.VIEWPORT_HEIGHT, 'vh;\n',
            '    overflow-y: auto;\n',
            '    padding: ', CONFIG.ui.typography.scale.base, 'rem;\n',
            '}\n\n'
        ]));
    }
    
    buildContentStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            '/* Main Content */\n',
            '.content {\n',
            '    margin-left: ', CONFIG.ui.layout.sidebarWidth, 'px;\n',
            '    padding: ', CONFIG.ui.spacing.large, 'px ', CONFIG.ui.spacing.massive, 'px;\n',
            '    max-width: ', CONFIG.ui.layout.contentMaxWidth, 'px;\n',
            '    width: ', CONFIG.ui.dimensions.full, ';\n',
            '}\n\n',
            '.section-heading {\n',
            '    font-family: var(--sans);\n',
            '    margin: ', CONFIG.ui.spacing.large, 'px 0 ', CONFIG.ui.spacing.medium, 'px;\n',
            '    position: ', CONFIG.css.position.relative, ';\n',
            '    padding-left: ', CONFIG.ui.spacing.huge, 'px;\n',
            '}\n\n'
        ]));
    }
    
    buildMathStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            '/* Math Rendering */\n',
            '.', CONFIG.strings.blockContentClass, ' {\n',
            '    display: ', CONFIG.css.display.block, ';\n',
            '    margin: ', CONFIG.ui.typography.scale.medium, 'rem 0;\n',
            '    padding: ', CONFIG.ui.typography.scale.base, 'rem;\n',
            '    background: ', CONFIG.colors.background.code, ';\n',
            '    border-left: ', CONFIG.ui.spacing.tiny, 'px solid var(--link);\n',
            '    overflow-x: auto;\n',
            '    font-family: \'STIX Two Math\', \'Cambria Math\', serif;\n',
            '    font-size: ', CONFIG.ui.typography.scale.medium, 'em;\n',
            '    text-align: ', CONFIG.css.align.center, ';\n',
            '}\n\n',
            '.', CONFIG.strings.inlineContentClass, ' {\n',
            '    font-family: \'STIX Two Math\', \'Cambria Math\', serif;\n',
            '    font-size: ', CONFIG.ui.typography.scale.base, 'em;\n',
            '    padding: 0 ', CONFIG.ui.typography.emScale.small, 'em;\n',
            '}\n\n'
        ]));
    }
    
    buildCodeStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            '/* Code blocks */\n',
            'pre {\n',
            '    background: ', CONFIG.colors.background.code, ';\n',
            '    border: ', CONFIG.ui.borderWidth, 'px solid var(--border);\n',
            '    border-radius: ', CONFIG.ui.spacing.compact, 'px;\n',
            '    padding: ', CONFIG.ui.typography.scale.base, 'rem;\n',
            '    margin: ', CONFIG.ui.typography.scale.small, 'rem 0;\n',
            '    overflow-x: auto;\n',
            '}\n\n',
            'code {\n',
            '    font-family: var(--mono);\n',
            '    font-size: ', CONFIG.ui.typography.scale.small, 'em;\n',
            '    background: ', CONFIG.colors.background.code, ';\n',
            '    padding: ', CONFIG.ui.typography.emScale.small, 'em ', CONFIG.ui.typography.emScale.medium, 'em;\n',
            '    border-radius: ', CONFIG.ui.spacing.tiny, 'px;\n',
            '}\n\n'
        ]));
    }
    
    buildResponsiveStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            '/* Responsive */\n',
            '@media (max-width: ', CONFIG.ui.layout.mediaBreakpoint, 'px) {\n',
            '    .toc-sidebar {\n',
            '        transform: ', CONFIG.ui.transform.offscreen, ';\n',
            '        transition: transform ', CONFIG.ui.transition.slow, 's;\n',
            '    }\n',
            '    .toc-sidebar.open {\n',
            '        transform: ', CONFIG.ui.transform.none, ';\n',
            '    }\n',
            '    .content {\n',
            '        margin-left: 0;\n',
            '    }\n',
            '}\n\n'
        ]));
    }
    
    buildPrintStyles(prev) {
        return new Lazy(() => new LazyTemplate([
            prev,
            '/* Print styles */\n',
            '@media print {\n',
            '    .toc-sidebar {\n',
            '        position: ', CONFIG.css.position.static, ';\n',
            '        width: ', CONFIG.ui.dimensions.full, ';\n',
            '        page-break-after: always;\n',
            '    }\n',
            '    .content {\n',
            '        margin-left: 0;\n',
            '    }\n',
            '    .anchor-link {\n',
            '        display: ', CONFIG.css.display.none, ';\n',
            '    }\n',
            '}\n'
        ]));
    }

 
    generateJS() {
       
        const js = CONFIG;
        
        return `
// Navigation functions
function navigateToSection(id, event) {
    if (event) event.preventDefault();
    
    const element = document.getElementById(id);
    if (element) {
        element.scrollIntoView({ behavior: '${js.strings.scrollBehavior.smooth}', block: '${js.strings.scrollBlock.start}' });
        
       
        document.querySelectorAll('.' + '${js.strings.navigationLinkClass}').forEach(link => {
            link.classList.remove('${js.strings.classActive}');
        });
        document.querySelector(\`[data-section="\${id}"]\`)?.classList.add('${js.strings.classActive}');
        
       
        history.pushState(null, null, '#' + id);
    }
}

function toggleSection(id) {
    const section = document.getElementById(id);
    if (!section) return;
    
   
    const button = document.querySelector(\`button[onclick="toggleSection('\${id}')"]\`);
    if (!button) return;
    
    const isHidden = section.style.display === 'none' || !section.style.display;
    
    if (isHidden) {
        section.style.display = 'block';
        button.setAttribute('aria-expanded', 'true');
        const icon = button.querySelector('.${js.strings.toggleIconClass}');
        if (icon) icon.textContent = '${js.strings.expandedIndicator}';
    } else {
        section.style.display = 'none';
        button.setAttribute('aria-expanded', 'false');
        const icon = button.querySelector('.${js.strings.toggleIconClass}');
        if (icon) icon.textContent = '${js.strings.collapsedIndicator}';
    }
}

function expandAll() {
    const button = document.querySelector('.' + '${js.strings.expandControlClass}');
    const sections = document.querySelectorAll('.' + '${js.strings.childrenContainerClass}');
    const toggles = document.querySelectorAll('.' + '${js.strings.toggleControlClass}');
    
    const allExpanded = Array.from(sections).every(s => s.style.display !== '${js.css.display.none}');
    
    sections.forEach(section => {
        section.style.display = allExpanded ? '${js.css.display.none}' : '${js.css.display.block}';
    });
    
    toggles.forEach(toggle => {
        toggle.setAttribute('${js.strings.expandedAttribute}', !allExpanded);
    });
    
    button.textContent = allExpanded ? '${js.strings.expandAllLabel}' : '${js.strings.collapseAllLabel}';
}

// Highlight current section on scroll
document.addEventListener('${js.strings.domEvents.contentLoaded}', function() {
    const sections = document.querySelectorAll('.' + '${js.strings.documentSectionClass}');
    const tocLinks = document.querySelectorAll('.' + '${js.strings.navigationLinkClass}');
    
    function highlightTOC(fromScroll = false) {
        let current = '';
        sections.forEach(section => {
            const rect = section.getBoundingClientRect();
            if (rect.top <= ${js.watcher.initialBuildCheckInterval}) {
                current = section.dataset.sectionId;
            }
        });
        
        tocLinks.forEach(link => {
            link.classList.remove('${js.strings.classActive}');
            if (link.dataset.section === current) {
                link.classList.add('${js.strings.classActive}');
                
               
                if (fromScroll) {
                   
                }
            }
        });
    }
    
    window.addEventListener('${js.strings.domEvents.scroll}', () => highlightTOC(true));
    highlightTOC(false);
    
   
    if (window.location.hash) {
        setTimeout(() => {
            const id = window.location.hash.slice(${js.ui.layout.hashSliceStart});
            navigateToSection(id);
        }, ${js.ui.scrollDebounceDelay});
    }
});
`;
    }
}

// PDF MODALITY

class PDFModality extends HTMLModality {
    generateHTML(processor) {
       
        this.currentProcessor = processor;
        
        const toc = processor.generateTOC();
        const tocHTML = this.renderPDFTOC(toc);
        
        let sectionsHTML = [];
        for (const [id, section] of processor.sections) {
            const content = processor.data.get(id);
            sectionsHTML.push(this.renderPDFSection(section, content));
        }
        
        return `<!DOCTYPE html>
<html lang="${CONFIG.strings.defaultLanguage}">
<head>
    <meta charset="${CONFIG.strings.standardCharset}">
    <style>
        @page {
            size: letter;
            margin: ${CONFIG.print.pageMargin};
        }
        
        body {
            font-family: 'Times New Roman', serif;
            font-size: ${CONFIG.print.fontSize.body}pt;
            line-height: ${CONFIG.ui.typography.lineHeight.normal};
            color: ${CONFIG.colors.text.emphasis};
        }
        
        /* TOC Page */
        .toc-page {
            page-break-after: always;
        }
        
        .toc-title {
            font-size: ${CONFIG.print.fontSize.h1}pt;
            margin-bottom: ${CONFIG.ui.typography.scale.medium}rem;
            text-align: ${CONFIG.css.align.center};
        }
        
        .toc-entry {
            margin: ${CONFIG.ui.typography.emScale.large}em 0;
            page-break-inside: avoid;
        }
        
        .toc-entry a {
            color: ${CONFIG.colors.text.emphasis};
            text-decoration: ${CONFIG.css.textDecoration.none};
            display: ${CONFIG.css.display.block};
        }
        
        .toc-entry a:hover {
            text-decoration: ${CONFIG.css.textDecoration.underline};
        }
        
        .toc-level-0 { margin-left: 0; font-weight: ${CONFIG.ui.typography.weight.bold}; }
        .toc-level-1 { margin-left: ${CONFIG.print.spacing.indent}em; }
        .toc-level-2 { margin-left: ${CONFIG.ui.spacing.tiny}em; }
        
        .toc-page-number {
            float: right;
        }
        
        /* Content */
        h1, h2, h3, h4 {
            font-family: ${CONFIG.strings.fallbackFontStack};
            page-break-after: avoid;
        }
        
        h1 { font-size: ${CONFIG.print.fontSize.h1}pt; margin: ${CONFIG.print.spacing.h1.top}pt 0 ${CONFIG.print.spacing.h1.bottom}pt; }
        h2 { font-size: ${CONFIG.print.fontSize.h2}pt; margin: ${CONFIG.print.spacing.h2.top}pt 0 ${CONFIG.print.spacing.h2.bottom}pt; }
        h3 { font-size: ${CONFIG.print.fontSize.h3}pt; margin: ${CONFIG.print.spacing.h3.top}pt 0 ${CONFIG.print.spacing.h3.bottom}pt; }
        h4 { font-size: ${CONFIG.print.fontSize.h4}pt; margin: ${CONFIG.print.spacing.h4.top}pt 0 ${CONFIG.print.spacing.h4.bottom}pt; }
        
        /* Math */
        .math-block {
            display: ${CONFIG.css.display.block};
            margin: ${CONFIG.print.spacing.block}pt 0;
            text-align: ${CONFIG.css.align.center};
            font-family: 'Cambria Math', serif;
        }
        
        .math-inline {
            font-family: 'Cambria Math', serif;
        }
        
        /* Links in PDF should be blue */
        a {
            color: ${CONFIG.colors.link.default};
            text-decoration: ${CONFIG.css.textDecoration.underline};
        }
        
        pre {
            background: ${CONFIG.colors.background.highlight};
            padding: ${CONFIG.print.spacing.inline}pt;
            margin: ${CONFIG.print.spacing.inline}pt 0;
            page-break-inside: avoid;
            font-size: ${CONFIG.print.fontSize.footnote}pt;
        }
        
        code {
            font-family: 'Courier New', monospace;
            font-size: ${CONFIG.print.fontSize.footnote}pt;
        }
        
        /* Back to TOC navigation */
        .back-to-toc {
            display: ${CONFIG.css.display.inlineBlock};
            margin-top: ${CONFIG.print.spacing.inline}pt;
            font-size: ${CONFIG.print.fontSize.footnote}pt;
            color: ${CONFIG.colors.link.default};
            text-decoration: ${CONFIG.css.textDecoration.none};
        }
        
        .back-to-toc:before {
            content: '← ';
        }
    </style>
</head>
<body>
    <div class="toc-page" id="toc">
        <h1 class="toc-title">Contents</h1>
        ${tocHTML}
    </div>
    ${sectionsHTML.join('\n')}
</body>
</html>`;
    }
    
    renderPDFSection(section, content) {

        if (section.title && (
            section.title === 'Contents' ||
            section.title === 'Table of Contents' ||
            section.title.toLowerCase() === 'contents' ||
            section.title.toLowerCase() === 'table of contents'
        )) {
            return '';
        }

        const processedTitle = this.processTextToken(section.title);
        const heading = `<h${section.level} id="${section.id}">
            ${processedTitle}
        </h${section.level}>`;


        const backToTOC = section.level <= CONFIG.processor.tocMaxDepth ?
            '<a href="#toc" class="back-to-toc">Back to Contents</a>' : '';

        const blocks = this.renderBlocks(content);
        
        return `<section>
            ${heading}
            ${backToTOC}
            ${blocks}
        </section>`;
    }
    
    renderPDFTOC(toc, level = 0) {
        if (!toc || toc.length === 0) return '';

        return toc.map(entry => {
            const processedTitle = this.processTextToken(entry.title);
            return `
            <div class="toc-entry toc-level-${level}">
                <a href="#${entry.id}" style="text-decoration: none; color: inherit;">
                    ${processedTitle}
                </a>
                ${entry.children && entry.children.length > 0 ?
                    this.renderPDFTOC(entry.children, level + 1) : ''}
            </div>`;
        }).join('');
    }
}

// MARKDOWN MODALITY

class MarkdownModality {
    render(processor) {
        let output = [];
        
        const toc = processor.generateTOC();
        if (toc.length > 0) {
            output.push('# Table of Contents\n');
            output.push(this.renderTOC(toc));
            output.push('\n---\n');
        }
        
        for (const [id, section] of processor.sections) {
            const content = processor.data.get(id);
            output.push(this.renderSection(section, content));
        }
        
        return output.join('\n');
    }
    
    renderTOC(toc, level = 0) {
        return toc.map(entry => {
            const indent = '  '.repeat(level);
            const link = `[${entry.title}](#${entry.id})`;
            const children = entry.children && entry.children.length > 0 ? 
                '\n' + this.renderTOC(entry.children, level + 1) : '';
            return `${indent}- ${link}${children}`;
        }).join('\n');
    }
    
    renderSection(section, content) {
        const heading = '#'.repeat(section.level) + ' ' + section.title;
        const blocks = this.renderBlocks(content);
        return `${heading}\n\n${blocks}\n`;
    }
    
    renderBlocks(blocks) {
        if (!blocks) return '';
        
        return blocks.map(block => {
            switch (block.type) {
                case 'paragraph':
                    return block.content;
                case 'list-item':
                    const marker = block.ordered ? '1.' : '-';
                    return `${marker} ${block.content}`;
                case 'code':
                    return '```' + block.language + '\n' + block.content + '\n```';
                case 'blockquote':
                    return `> ${block.content}`;
                case 'hr':
                    return '---';
                default:
                    return block.content;
            }
        }).join('\n\n');
    }
}

// BUILD SYSTEM

// Files are defined in CONFIG - no dynamic discovery
const FILES = [CONFIG.files.workingDoc, CONFIG.files.primerDoc];

// Mandatory files that must be staged before push
const MANDATORY_COMMIT_FILES = [
    CONFIG.files.buildScript,
    CONFIG.files.readmeFile,
    CONFIG.files.indexFile,
    'LICENSE',
    CONFIG.files.primerDoc.txt,
    CONFIG.files.workingDoc.txt,
    CONFIG.files.primerDoc.html,
    CONFIG.files.primerDoc.md,
    CONFIG.files.primerDoc.pdf,
    CONFIG.files.workingDoc.html,
    CONFIG.files.workingDoc.md,
    CONFIG.files.workingDoc.pdf
];

async function verifyCommitReadiness(isOnlinePush = false) {
    try {
       
        if (!isOnlinePush) {
           
           
            return true;
        }
        
       
        const changedFiles = await lazyGit.changedFiles().pull();
        const stagedFiles = await lazyGit.diff('--cached').pull();
        
        const missingFromStaging = [];
        for (const mandatoryFile of MANDATORY_COMMIT_FILES) {
            const fileChanged = changedFiles.some(f => f.file === mandatoryFile);
            if (fileChanged && !stagedFiles.includes(mandatoryFile)) {
                missingFromStaging.push(mandatoryFile);
            }
        }
        
        if (missingFromStaging.length > 0) {
            logger.error('ERROR: MANDATORY FILES NOT STAGED FOR ONLINE PUSH:');
            missingFromStaging.forEach(f => logger.error(`  - ${f}`));
            logger.error('\nUse: await lazyGit.stage(' + JSON.stringify(missingFromStaging) + ').pull()');
            return false;
        }
        return true;
    } catch (e) {
        throw new Error(`Git verification failed: ${e.message}`);
    }
}

// LRU page pool prevents memory leaks from accumulating browser pages
class PagePool {
    constructor(maxSize = 10) {
        this.pages = new Map();
        this.lru = [];
        this.maxSize = maxSize;
    }

    get(name) {
        if (this.pages.has(name)) {
            this.lru = this.lru.filter(n => n !== name);
            this.lru.push(name);
            return this.pages.get(name);
        }
        return undefined;
    }

    async set(name, page) {
        if (this.pages.size >= this.maxSize && !this.pages.has(name)) {
            const oldest = this.lru.shift();
            const oldPage = this.pages.get(oldest);
            if (oldPage && !oldPage.isClosed()) {
                await oldPage.close().catch(() => {});
            }
            this.pages.delete(oldest);
        }

        this.pages.set(name, page);
        this.lru = this.lru.filter(n => n !== name);
        this.lru.push(name);
        return this;
    }

    delete(name) {
        this.lru = this.lru.filter(n => n !== name);
        return this.pages.delete(name);
    }

    clear() {
        this.lru = [];
        this.pages.clear();
    }

    get size() {
        return this.pages.size;
    }

    has(name) {
        return this.pages.has(name);
    }

    keys() {
        return this.pages.keys();
    }

    values() {
        return this.pages.values();
    }

    entries() {
        return this.pages.entries();
    }

    forEach(callback, thisArg) {
        return this.pages.forEach(callback, thisArg);
    }

    [Symbol.iterator]() {
        return this.pages[Symbol.iterator]();
    }
}

const processor = new DocumentProcessor();

processor.state = {
    browser: null,
    pages: new PagePool(10),
    hashes: new Map(),
    building: new Set(),
    errors: [],
    intervals: [],
    stats: {
        builds: 0,
        uptime: Date.now()
    }
};

// Smart process lock manager integrated into build system
class ProcessLockManager {
    constructor() {
        this.lockFile = path.join(PROJECT_ROOT, CONFIG.files.lockFile);
        this.heartbeatInterval = null;
        this.isOwner = false;
    }
    
    isProcessRunning(pid) {
        try {
           
            process.kill(pid, CONFIG.processor.signalKillDefault);
            return true;
        } catch (error) {
            return false;
        }
    }
    
    acquire() {
        try {

            if (lazyFS.exists(this.lockFile, false).value) {
                const lockData = JSON.parse(fs.readFileSync(this.lockFile, CONFIG.strings.standardEncoding));
                const lockAge = Date.now() - lockData.timestamp;


                if (this.isProcessRunning(lockData.pid)) {

                    if (lockAge < CONFIG.process.lockAliveCheckTime) {
                        logger.error(`[LOCK] Build already running (PID: ${lockData.pid})`);
                        logger.log(CONFIG.strings.lockWaitingMessage);


                        for (let i = 0; i < CONFIG.process.lockRetryAttempts; i++) {
                            if (!lazyFS.exists(this.lockFile, false).value) {
                                break;
                            }

                            execSync(
                                process.platform === CONFIG.strings.windowsPlatform ? CONFIG.strings.windowsSleepCommand() : CONFIG.strings.unixSleepCommand(),
                                {stdio: 'ignore'}
                            );
                        }


                        if (lazyFS.exists(this.lockFile, false).value) {
                            const updatedLockData = JSON.parse(fs.readFileSync(this.lockFile, CONFIG.strings.standardEncoding));
                            if (this.isProcessRunning(updatedLockData.pid)) {
                                logger.error(CONFIG.strings.lockStillRunningMessage);
                                return false;
                            }
                        }
                    }
                }


                if (lazyFS.exists(this.lockFile, false).value) {
                    const finalCheck = JSON.parse(fs.readFileSync(this.lockFile, CONFIG.strings.standardEncoding));
                    if (this.isProcessRunning(finalCheck.pid)) {

                        return false;
                    }
                    fs.unlinkSync(this.lockFile);
                }
            }
            
           
            this.writeLock();
            this.isOwner = true;
            
           
            this.heartbeatInterval = setInterval(() => {
                if (this.isOwner) {
                    this.writeLock();
                }
            }, CONFIG.process.heartbeatInterval);
            
            return true;
        } catch (error) {
            logger.error(CONFIG.strings.lockErrorPrefix, error);
           
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            return false;
        }
    }
    
    writeLock() {
        const tempFile = this.lockFile + '.tmp';
        const lockData = JSON.stringify({
            pid: process.pid,
            timestamp: Date.now(),
            version: CONFIG.strings.buildVersion,
            started: new Date().toISOString()
        });
       
        try {
            fs.writeFileSync(tempFile, lockData);
            fs.renameSync(tempFile, this.lockFile);
        } catch (error) {
           
            fs.unlinkSync(tempFile);
            throw error;
        }
    }
    
    release() {
        try {
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            
            if (this.isOwner && lazyFS.exists(this.lockFile).value) {
               
                const lockData = JSON.parse(fs.readFileSync(this.lockFile, CONFIG.strings.standardEncoding));
                if (lockData.pid === process.pid) {
                    fs.unlinkSync(this.lockFile);
                    this.isOwner = false;
                }
            }
        } catch (error) {
            logger.error(CONFIG.strings.lockCleanupErrorPrefix, error);
        }
    }
}

const lockManager = new ProcessLockManager();

// VIEW RENDERING

function renderView(config, data) {
    if (config.type === 'document-index') {
        return renderDocumentIndex(config, data);
    }
}

function renderDocumentIndex(config, documents) {
    const extractDescription = (text) => {
       
        if (text.includes(CONFIG.content.experienceTitle)) {
            return CONFIG.content.experienceDescription;
        } else if (text.includes(CONFIG.content.primerTitle)) {
            return CONFIG.content.primerDescription;
        }
        return CONFIG.content.defaultDescription;
    };
    
    const formatFileSize = (bytes) => {
        if (bytes < CONFIG.processor.mediumSizeThreshold) return bytes + CONFIG.strings.smallSizeUnit;
        if (bytes < CONFIG.processor.largeSizeThreshold) return (bytes / CONFIG.processor.mediumSizeThreshold).toFixed(CONFIG.processor.coarsePrecision) + CONFIG.strings.mediumSizeUnit;
        return (bytes / CONFIG.processor.largeSizeThreshold).toFixed(2) + CONFIG.strings.largeSizeUnit;
    };
    
    const docInfo = documents.map(doc => {
        const txtPath = CONFIG.resolveDocPath(doc, 'txt');
        const content = fs.readFileSync(txtPath, CONFIG.strings.standardEncodingDash);
        const description = extractDescription(content);

       
        const getSize = (filepath) => fs.statSync(filepath).size;

        const htmlSize = getSize(CONFIG.resolveDocPath(doc, 'html'));
        const pdfSize = getSize(CONFIG.resolveDocPath(doc, 'pdf'));
        const mdSize = getSize(CONFIG.resolveDocPath(doc, 'md'));
        
       
        const sectionCount = content.match(CONFIG.patterns.sectionCount)?.length;
        
        return {
            name: doc.name,
            description,
            formats: {
                html: { file: doc.html, size: formatFileSize(htmlSize) },
                pdf: { file: doc.pdf, size: formatFileSize(pdfSize) },
                md: { file: doc.md, size: formatFileSize(mdSize) },
                txt: { file: doc.txt, size: formatFileSize(getSize(txtPath)) }
            },
            sections: sectionCount,
            lastModified: new Date().toISOString()
        };
    });
    
   
    const version = Date.now();
    
    const html = `<!DOCTYPE html>
<html lang="${CONFIG.strings.defaultLanguage}">
<head>
    <meta charset="${CONFIG.strings.standardCharset}">
    <meta name="viewport" content="${CONFIG.strings.viewportContent}">
    <meta http-equiv="Cache-Control" content="${CONFIG.strings.cacheControlContent}">
    <meta http-equiv="Pragma" content="${CONFIG.strings.pragmaContent}">
    <meta http-equiv="Expires" content="${CONFIG.strings.expiresContent}">
    <title>${CONFIG.strings.documentTitle}</title>
    <style>
        body {
            font-family: ${CONFIG.strings.primaryFontStack};
            line-height: ${CONFIG.ui.typography.lineHeight.loose};
            color: ${CONFIG.colors.text.heading};
            background: ${CONFIG.colors.background.subtle};
            max-width: ${CONFIG.ui.layout.contentWideWidth}px;
            margin: ${CONFIG.ui.spacing.giant}px auto;
            padding: 0 ${CONFIG.ui.spacing.huge}px;
        }
        
        h1 {
            font-size: ${CONFIG.ui.typography.pixels.huge}px;
            font-weight: ${CONFIG.ui.typography.weight.light};
            margin-bottom: ${CONFIG.ui.spacing.normal}px;
            letter-spacing: ${CONFIG.ui.typography.letterSpacing.tight}px;
        }
        
        .subtitle {
            color: ${CONFIG.colors.text.muted};
            margin-bottom: ${CONFIG.ui.spacing.giant}px;
            font-size: ${CONFIG.ui.typography.pixels.body}px;
        }
        
        .document {
            background: ${CONFIG.colors.neutralBase};
            margin: ${CONFIG.ui.spacing.large}px 0;
            padding: ${CONFIG.ui.spacing.huge}px;
            border: ${CONFIG.ui.borderWidth}px solid ${CONFIG.colors.border.light};
            box-shadow: ${CONFIG.ui.shadow.offset.none}px ${CONFIG.ui.shadow.offset.small}px ${CONFIG.ui.shadow.blur.soft}px ${CONFIG.colors.shadowBase}${CONFIG.ui.shadow.opacity.subtle});
        }
        
        .document h2 {
            font-size: ${CONFIG.ui.typography.pixels.xlarge}px;
            margin: 0 0 ${CONFIG.ui.spacing.normal}px 0;
            font-weight: ${CONFIG.ui.typography.weight.regular};
        }
        
        .description {
            color: ${CONFIG.colors.text.muted};
            margin-bottom: ${CONFIG.ui.spacing.medium}px;
            line-height: ${CONFIG.ui.typography.lineHeight.tight};
            font-size: ${CONFIG.ui.typography.pixels.body}px;
        }
        
        .metadata {
            font-size: ${CONFIG.ui.typography.pixels.small}px;
            color: ${CONFIG.colors.text.disabled};
            margin-bottom: ${CONFIG.ui.spacing.medium}px;
        }
        
        .metadata span + span::before {
            content: "${CONFIG.strings.metadataSeparator}";
            margin: 0 ${CONFIG.ui.spacing.small}px;
        }
        
        .formats {
            display: ${CONFIG.css.display.flex};
            gap: ${CONFIG.ui.spacing.normal}px;
        }
        
        .format-link {
            padding: ${CONFIG.ui.spacing.compact}px ${CONFIG.ui.spacing.medium}px;
            background: ${CONFIG.colors.background.subtle};
            border: ${CONFIG.ui.borderWidth}px solid ${CONFIG.colors.border.medium};
            text-decoration: ${CONFIG.css.textDecoration.none};
            color: ${CONFIG.colors.link.visited};
            font-size: ${CONFIG.ui.typography.pixels.small}px;
            transition: ${CONFIG.ui.cssProps.all} ${CONFIG.ui.transition.fast}s ${CONFIG.ui.cssProps.ease};
        }
        
        .format-link:hover {
            background: ${CONFIG.colors.link.visited};
            color: ${CONFIG.colors.neutralBase};
            border-color: ${CONFIG.colors.link.visited};
        }
        
        .format-type {
            font-weight: ${CONFIG.ui.typography.weight.medium};
            text-transform: lowercase;
        }
        
        .format-size {
            opacity: ${CONFIG.ui.opacity.strong};
            margin-left: ${CONFIG.ui.spacing.small}px;
            font-size: ${CONFIG.ui.typography.pixels.tiny}px;
        }
        
        .format-link:hover .format-size {
            opacity: ${CONFIG.ui.opacity.heavy};
        }
        
        .footer {
            margin-top: ${CONFIG.ui.spacing.giant}px;
            padding-top: ${CONFIG.ui.spacing.large}px;
            border-top: ${CONFIG.ui.borderWidth}px solid ${CONFIG.colors.border.light};
            font-size: ${CONFIG.ui.typography.pixels.small}px;
            color: ${CONFIG.colors.text.disabled};
            display: ${CONFIG.css.display.flex};
            justify-content: ${CONFIG.css.align.spaceBetween};
            align-items: ${CONFIG.css.align.center};
        }
        
        .github-link {
            color: ${CONFIG.colors.link.default};
            text-decoration: ${CONFIG.css.textDecoration.underline};
            font-weight: ${CONFIG.ui.typography.weight.medium};
            transition: ${CONFIG.ui.cssProps.all} ${CONFIG.ui.transition.fast}s ${CONFIG.ui.cssProps.ease};
        }
        
        .github-link:hover {
            color: ${CONFIG.colors.link.hover};
            background: ${CONFIG.colors.background.sidebar};
            padding: ${CONFIG.ui.spacing.tiny}px ${CONFIG.ui.spacing.compact}px;
            margin: -${CONFIG.ui.spacing.tiny}px -${CONFIG.ui.spacing.compact}px;
        }
    </style>
</head>
<body>
    <h1>${CONFIG.strings.documentTitle}</h1>
    <p class="subtitle">Documentation</p>
    
    ${docInfo.map(doc => `
    <div class="document">
        <h2>${doc.name}</h2>
        <p class="description">${doc.description}</p>
        <div class="metadata">
            <span>${doc.sections} sections</span>
            <span>${new Date(doc.lastModified).toLocaleDateString()}</span>
        </div>
        <div class="formats">
            <a href="${doc.formats.html.file.replace('output/', '')}?v=${version}" class="format-link">
                <span class="format-type">html</span>
                <span class="format-size">${doc.formats.html.size}</span>
            </${CONFIG.strings.linkElement}>
            <a href="${doc.formats.pdf.file.replace('output/', '')}?v=${version}" class="format-link">
                <span class="format-type">pdf</span>
                <span class="format-size">${doc.formats.pdf.size}</span>
            </${CONFIG.strings.linkElement}>
            <a href="${doc.formats.md.file.replace('output/', '')}?v=${version}" class="format-link">
                <span class="format-type">markdown</span>
                <span class="format-size">${doc.formats.md.size}</span>
            </${CONFIG.strings.linkElement}>
            <a href="../${doc.formats.txt.file}?v=${version}" class="format-link">
                <span class="format-type">source</span>
                <span class="format-size">${doc.formats.txt.size}</span>
            </${CONFIG.strings.linkElement}>
        </div>
    </div>
    `).join('')}
    
    <div class="footer">
        <span>${new Date().toLocaleString()}</span>
        <a href="${CONFIG.urls.repositoryLink}" class="github-link">GitHub</a>
    </div>
</body>
</html>`;
    
   
    return lazyFS.write(path.join(PROJECT_ROOT, CONFIG.files.indexFile), html);
}

const createBuildMorphisms = (deps) => {
    const {
        CONFIG,
        lazyFS,
        crypto,
        path,
        traceOrchestrator,
        hasher,
        PROJECT_ROOT,
        DocumentProcessor,
        Lazy,
        LazyTemplate,
        generatePDF,
        initPullGraph,
        lazyEvents,
        THRESHOLDS
    } = deps;

    return {
        validateFileExists: (docConfig) => new PullPromise(async () => {
            const txtPath = CONFIG.resolveDocPath(docConfig, 'txt');
            const exists = lazyFS.exists(txtPath).value;
            if (!exists) throw new Error(`File not found: ${txtPath}`);
            return { txtPath, docConfig };
        }),

        readFileContent: (data) => new PullPromise(async () => {
            const content = lazyFS.read(data.txtPath).value;
            return { content, docConfig: data.docConfig };
        }),

        computeHash: (data) => new PullPromise(async () => {
            const hash = crypto.createHash(CONFIG.strings.mainHashAlgorithm)
                .update(data.content)
                .digest(CONFIG.strings.hashEncoding);
            return { content: data.content, hash, file: data.docConfig.txt, docConfig: data.docConfig };
        }),

        addMetadata: (data) => new PullPromise(async () => {
            const outputBaseName = path.basename(data.docConfig.html, '.html');
            traceOrchestrator.trace('BUILD_START', { file: data.file, name: outputBaseName, hash: data.hash });
            return { ...data, name: outputBaseName };
        }),

        generateFormats: (data) => new PullPromise(async () => {
            if (!data || !data.content) {
                throw new Error(`Invalid build data: missing content for ${data?.file}`);
            }

            const processor = new DocumentProcessor();
            try {
                const parseResult = processor.parse(data.content);
                if (parseResult instanceof Lazy) {
                    parseResult.value;
                }
            } catch (parseError) {
                traceOrchestrator.error(parseError, {
                    context: 'DOCUMENT_PARSE_FAILED',
                    file: data.file,
                    contentLength: data.content?.length
                });
                throw new Error(`Failed to parse document ${data.file}: ${parseError.message}`);
            }

            if (!processor.modalities || !processor.modalities.html || !processor.modalities.pdf || !processor.modalities.markdown) {
                throw new Error(`DocumentProcessor modalities not properly initialized for ${data.file}`);
            }

            const formats = {};

            const htmlGenerator = new Lazy(() => processor.modalities.html.generateHTML(processor));
            formats.html = htmlGenerator.value;
            if (formats.html instanceof Lazy) {
                formats.html = formats.html.value;
            }
            if (formats.html instanceof LazyTemplate) {
                formats.html = formats.html.toString();
            }
            if (!formats.html || formats.html.length === 0) {
                throw new Error('HTML generation produced empty output');
            }
            hasher.absorb(formats.html, 'format-html');

            const pdfGenerator = new Lazy(() => processor.modalities.pdf.generateHTML(processor));
            formats.pdf = pdfGenerator.value;
            if (formats.pdf instanceof Lazy) {
                formats.pdf = formats.pdf.value;
            }
            if (formats.pdf instanceof LazyTemplate) {
                formats.pdf = formats.pdf.toString();
            }
            if (!formats.pdf || formats.pdf.length === 0) {
                throw new Error('PDF HTML generation produced empty output');
            }
            hasher.absorb(formats.pdf, 'format-pdf');

            const mdGenerator = new Lazy(() => processor.modalities.markdown.render(processor));
            formats.md = mdGenerator.value;
            if (formats.md instanceof Lazy) {
                formats.md = formats.md.value;
            }
            if (formats.md instanceof LazyTemplate) {
                formats.md = formats.md.toString();
            }
            if (!formats.md || formats.md.length === 0) {
                throw new Error('Markdown generation produced empty output');
            }
            hasher.absorb(formats.md, 'format-markdown');

            return { ...data, formats };
        }),

        writeOutputFiles: (data) => new PullPromise(async () => {
            if (!data.formats || Object.keys(data.formats).length === 0) {
                throw new Error(`No formats generated for ${data.file}`);
            }

            const writeResults = {
                success: [],
                failed: []
            };

            if (data.formats.html) {
                try {
                    const htmlPath = path.join(PROJECT_ROOT, data.docConfig.html);
                    await lazyFS.write(htmlPath, data.formats.html).pull();
                    writeResults.success.push('html');
                } catch (htmlWriteError) {
                    writeResults.failed.push({ format: 'html', error: htmlWriteError.message });
                    traceOrchestrator.error(htmlWriteError, { context: 'HTML_WRITE_FAILED', file: data.file });
                }
            }

            if (data.formats.md) {
                try {
                    const mdPath = path.join(PROJECT_ROOT, data.docConfig.md);
                    await lazyFS.write(mdPath, data.formats.md).pull();
                    writeResults.success.push('md');
                } catch (mdWriteError) {
                    writeResults.failed.push({ format: 'md', error: mdWriteError.message });
                    traceOrchestrator.error(mdWriteError, { context: 'MD_WRITE_FAILED', file: data.file });
                }
            }

            if (data.formats.pdf) {
                try {
                    const pdfPath = path.join(PROJECT_ROOT, data.docConfig.pdf);
                    await generatePDF(data.formats.pdf, pdfPath, data.name);
                    writeResults.success.push('pdf');
                } catch (pdfError) {
                    writeResults.failed.push({ format: 'pdf', error: pdfError.message });
                    traceOrchestrator.error(pdfError, { context: 'PDF_GENERATION_FAILED', file: data.file });
                    throw pdfError;
                }
            }

            if (writeResults.failed.length > 0) {
                throw new Error(`Failed to write formats for ${data.file}: ${JSON.stringify(writeResults.failed)}`);
            }

            data.writeResults = writeResults;

            const pullGraph = initPullGraph();

            if (writeResults.success.includes('html')) {
                pullGraph.register(`file:${data.docConfig.html}`, new Lazy(() => true));
            }
            if (writeResults.success.includes('md')) {
                pullGraph.register(`file:${data.docConfig.md}`, new Lazy(() => true));
            }
            if (writeResults.success.includes('pdf')) {
                pullGraph.register(`file:${data.docConfig.pdf}`, new Lazy(() => true));
            }

            return data;
        }),

        buildComplete: (data) => new Lazy(() => {
            traceOrchestrator.trace('BUILD_COMPLETE', {
                file: data.file,
                name: data.name,
                formats: Object.keys(data.formats)
            });
            lazyEvents.emit({
                type: 'BUILD_SUCCESS',
                file: data.file,
                hash: data.hash
            });
            return data;
        }),

        createBuildContext: (gitCommit, builderHash) => ({
            timestamp: Date.now(),
            version: CONFIG.version,
            formats: ['html', 'pdf', 'md'],
            environment: process.env.NODE_ENV,
            gitCommit,
            dependencies: [builderHash]
        }),

        computeBuilderHash: (builderContent) => {
            try {
                const hash = crypto.createHash('sha256').update(builderContent).digest('hex').substring(0, THRESHOLDS.HASH_SHORT_LENGTH);
                return { name: 'builder', hash };
            } catch (e) {
                throw new Error(`Failed to compute builder hash: ${e.message}`);
            }
        },

        createCacheKey: (buildHash, file) => `build-${buildHash.value}-${file}`
    };
};

async function generatePDF(html, pdfPath, name) {
    if (!processor.state.browser) {
        try {
            if (traceOrchestrator) traceOrchestrator.trace('BROWSER_LAUNCH', { name });
            
            processor.state.browser = await puppeteer.launch({
                headless: CONFIG.strings.headlessMode,
                args: [
                    CONFIG.strings.sandboxFlag,
                    CONFIG.strings.setuidFlag,
                    CONFIG.strings.devShmFlag, 
                    CONFIG.strings.gpuFlag, 
                    CONFIG.strings.zygoteFlag 
                ],
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false
            });
            
            processor.state.browser.on('disconnected', () => {
                if (traceOrchestrator) traceOrchestrator.trace('BROWSER_DISCONNECTED', { name });
                processor.state.browser = null;
                processor.state.pages.clear();
            });
        } catch (error) {
            if (traceOrchestrator) traceOrchestrator.error(error, { context: 'BROWSER_LAUNCH', name });
            throw new Error(`Failed to launch browser: ${error.message}`);
        }
    }
    
    let page = processor.state.pages.get(name);
    let attempts = 0;
    const maxAttempts = CONFIG.browser.maxRetries;
    
    while (attempts < maxAttempts) {
        try {
            if (!page || page.isClosed()) {
                if (traceOrchestrator) traceOrchestrator.trace('PAGE_CREATE', { name, attempt: attempts });
                
                page = await processor.state.browser.newPage();
                await processor.state.pages.set(name, page);

                page.on('error', err => {
                    if (traceOrchestrator) traceOrchestrator.error(err, { context: 'PAGE_ERROR', name });
                });
                
                page.on('pageerror', err => {
                    if (traceOrchestrator) traceOrchestrator.error(err, { context: 'PAGE_JS_ERROR', name });
                });
            }
            
            await page.goto(CONFIG.strings.emptyPageUrl);
            await page.setContent(html, { waitUntil: CONFIG.strings.networkIdleState, timeout: CONFIG.browser.pageLoadTimeout });
            await page.pdf({
                path: pdfPath,
                format: CONFIG.strings.pageFormat,
                printBackground: true,
                margin: { top: CONFIG.ui.pdfMargin, right: CONFIG.ui.pdfMargin, bottom: CONFIG.ui.pdfMargin, left: CONFIG.ui.pdfMargin },
                timeout: CONFIG.browser.pdfTimeout
            });
            
            await page.goto(CONFIG.strings.emptyPageUrl);
            
            if (traceOrchestrator) {
                traceOrchestrator.trace('PDF_GENERATED', { 
                    name, 
                    path: pdfPath, 
                    attempt: attempts 
                });
            }
            break;
            
        } catch (error) {
            if (traceOrchestrator) {
                traceOrchestrator.error(error, { 
                    context: 'PDF_GENERATION', 
                    name, 
                    attempt: attempts 
                });
            }
            if (error.message && (
                error.message.includes(CONFIG.errors.detachedFrame) || 
                error.message.includes(CONFIG.errors.closedContext) ||
                error.message.includes(CONFIG.errors.targetClosed) ||
                error.message.includes(CONFIG.errors.sessionClosed)
            )) {
                
                try {
                    await page.close();
                } catch (e) {
                }
                processor.state.pages.delete(name);
                
                attempts++;
                if (attempts < maxAttempts) {
                    if (!processor.state.browser || !processor.state.browser.isConnected()) {
                        if (traceOrchestrator) traceOrchestrator.trace('BROWSER_RECONNECT', { name });
                        processor.state.browser = null;
                        return await generatePDF(html, pdfPath, name);
                    }
                    
                    page = await processor.state.browser.newPage();
                    await processor.state.pages.set(name, page);
                    continue;
                }
            }
            
            throw error;
        }
    }
}

// Deduplicator for file watch events
const watchDedup = new Map();
const DEDUP_WINDOW = CONFIG.watcher.dedupWindow;

function shouldProcessFileChange(file) {
    const now = Date.now();
    const lastEvent = watchDedup.get(file);
    
    if (lastEvent && (now - lastEvent) < DEDUP_WINDOW) {
        return false;
    }
    
    watchDedup.set(file, now);
    
   
    const toDelete = [];
    for (const [f, time] of watchDedup) {
        if (now - time > CONFIG.resources.retryDelay) {
            toDelete.push(f);
        }
    }
    toDelete.forEach(f => watchDedup.delete(f));
    
    return true;
}

async function watch() {
    const isOnlinePush = process.argv.includes(CONFIG.strings.cliFlags.push) || process.argv.includes(CONFIG.strings.cliFlags.online);


    if (!verifyCommitReadiness(isOnlinePush)) {
        if (isOnlinePush) {
            logger.error('\n[FATAL] Build aborted: Mandatory files not staged for online push');
            logger.error('Please stage all required files before pushing online.');
        } else {
            logger.error('\n[FATAL] Build aborted: Local build issue');
        }
        process.exit(CONFIG.process.exitCode.error);
    }


    if (isOnlinePush) {
        try {
            await lazyGit.commitWorkflow(MANDATORY_COMMIT_FILES, true).pull();
            process.exit(CONFIG.process.exitCode.success);
        } catch (error) {
            logger.error('[GIT ERROR]', error.message);
            process.exit(CONFIG.process.exitCode.error);
        }
    }

    try {
        const currentPid = process.pid;

        if (process.platform === 'win32') {
            try {
                const output = execSync('wmic process where "name=\'node.exe\'" get commandline,processid', { encoding: 'utf8' });
                const lines = output.split('\n').filter(l => l.includes('builder.js'));
                logger.log(`[CLEANUP] Found ${lines.length} builder.js processes`);

                lines.forEach(line => {
                    const pidMatch = line.match(/\s+(\d+)\s*$/);
                    if (pidMatch) {
                        const pid = parseInt(pidMatch[1]);
                        logger.log(`[CLEANUP] Found PID ${pid}, current PID ${currentPid}`);
                        if (pid !== currentPid) {
                            try {
                                execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
                                logger.log(`[CLEANUP] Killed stale builder.js process PID ${pid}`);
                            } catch (e) {
                                logger.error(`[CLEANUP] Failed to kill PID ${pid}: ${e.message}`);
                            }
                        }
                    } else {
                        logger.log(`[CLEANUP] No PID match in line: "${line.slice(0, 100)}"`);
                    }
                });
            } catch (e) {
                logger.error(`[CLEANUP] wmic failed: ${e.message}`);
            }
        } else {
            try {
                execSync(`pkill -9 -f 'node.*builder.js'`, { stdio: 'ignore' });
            } catch {}
        }

        const lockPaths = [
            path.join(os.tmpdir(), '.builder-lock'),
            path.join(os.homedir(), '.builder-lock')
        ];
        lockPaths.forEach(p => {
            try { fs.unlinkSync(p); } catch {}
        });
    } catch (err) {
        logger.error(`[CLEANUP] Failed: ${err.message}`);
    }

    if (!lockManager.acquire()) {
        logger.error(CONFIG.strings.fatalLockMessage);
        process.exit(CONFIG.process.exitCode.error);
    }

   
    await queryServer.start();

   
    const morphisms = createBuildMorphisms({
        CONFIG,
        lazyFS,
        crypto,
        path,
        traceOrchestrator,
        hasher,
        PROJECT_ROOT,
        DocumentProcessor,
        Lazy,
        LazyTemplate,
        generatePDF,
        initPullGraph,
        lazyEvents,
        THRESHOLDS
    });

    for (const file of FILES) {
        const buildId = `build-${file.txt}`;

       
        pullGraph.register(buildId, new Lazy(async () => {
            const fileBuildPipeline = Pipeline.kleisli(
                morphisms.validateFileExists,
                morphisms.readFileContent,
                morphisms.computeHash,
                morphisms.addMetadata,
                morphisms.generateFormats,
                morphisms.writeOutputFiles,
                morphisms.buildComplete
            )(file);
            return await fileBuildPipeline.pull();
        }));
        
       
        if (!file.dependencies) {
            throw new Error(`File ${file.txt} must have dependencies defined in CONFIG`);
        }

        const deps = file.dependencies.value;
        for (const [output, inputs] of Object.entries(deps)) {
           
            validateVec(inputs, 1, `${file.txt}.${output} dependencies`);

            const outputId = `${file.txt}.${output}`;
            pullGraph.register(outputId, new Lazy(() => buildId));

            for (const input of inputs) {
                const inputId = input === 'txt' ? buildId : `${file.txt}.${input}`;
                pullGraph.dependsOn(outputId, inputId);
            }
        }
    }
    
   
    const indexId = 'build-index';
    pullGraph.register(indexId, new Lazy(() => {
        const htmlFiles = FILES.map(f => `${f.txt}.html`);
        return htmlFiles;
    }));
    
    for (const file of FILES) {
        pullGraph.dependsOn(indexId, `${file.txt}.html`);
    }
    
   
    for (const file of FILES) {
        const buildId = `build-${file.txt}`;
        await pullGraph.pull(buildId);
    }
    
   
    await new Promise(resolve => setTimeout(resolve, TIME.DEBOUNCE));
    
   
    const artifactBarrier = new PullPromise(async () => {
       
        const waitForArtifact = async (path, maxWait = TIME.LONG) => {
            const start = Date.now();
            while (Date.now() - start < maxWait) {
                if (lazyFS.exists(path).value) {
                    const stats = fs.statSync(path);
                    if (stats.size > 0) return true; 
                }
                await new Promise(resolve => setTimeout(resolve, TIME.TICK));
            }
            return false;
        };
        
       
        const artifacts = [];
        for (const file of FILES) {
            artifacts.push(waitForArtifact(CONFIG.resolveDocPath(file, 'html')));
            artifacts.push(waitForArtifact(CONFIG.resolveDocPath(file, 'pdf')));
            artifacts.push(waitForArtifact(CONFIG.resolveDocPath(file, 'md')));
        }
        await Promise.all(artifacts);
    });
    
   
    await artifactBarrier.pull();
    const indexResult = CONFIG.morphisms.aggregator.apply(FILES);
    if (indexResult && indexResult.pull) {
        logger.log('[INDEX] Pulling index generation...');
        await indexResult.pull();
        logger.log('[INDEX] Index generation complete');
    }

    if (traceOrchestrator) {
        const metrics = traceOrchestrator.metricsCalculator.getMetrics();
        const perfProfile = traceOrchestrator.metricsCalculator.getPerformanceProfile();
        const criticalPath = traceOrchestrator.metricsCalculator.getCriticalPath();

        logger.log('\n========== BUILD METRICS ==========');
        logger.log(`Nodes Evaluated: ${pullGraph.pullCount} fresh, ${pullGraph.cacheHits} cached, ${pullGraph.totalPulls} total`);
        logger.log(`Event Rate: ${metrics.eventRate.toFixed(2)} events/sec`);
        logger.log(`Error Rate: ${metrics.errorRate.toFixed(2)} errors/sec`);

        if (perfProfile.length > 0) {
            logger.log('\nPerformance Profile:');
            perfProfile.slice(0, 5).forEach(cat => {
                logger.log(`  ${cat.category}: ${cat.avgTime.toFixed(2)}ms avg (${cat.count} ops)`);
            });
        }

        const cacheHits = Array.from(traceOrchestrator.store.performanceMarks.values())
            .filter(m => m.cacheHit).length;
        const totalPulls = traceOrchestrator.store.performanceMarks.size;
        if (totalPulls > 0) {
            const hitRate = (cacheHits / totalPulls * 100).toFixed(1);
            logger.log(`\nCache Hit Rate: ${hitRate}% (${cacheHits}/${totalPulls})`);
        }

        if (criticalPath.length > 0) {
            logger.log('\nLongest Error Paths:');
            criticalPath.slice(0, 3).forEach(p => {
                logger.log(`  ${p.duration}ms (${p.steps} steps): ${p.path.join(' → ')}`);
            });
        }

        if (traceOrchestrator.store.errors.size > 0) {
            logger.log(`\nErrors: ${traceOrchestrator.store.errors.size}`);
            for (const [errorId, errorData] of Array.from(traceOrchestrator.store.errors.entries()).slice(0, 3)) {
                logger.log(`  ${errorId}: ${errorData.error.message}`);
                if (errorData.causalChain && errorData.causalChain.length > 0) {
                    logger.log(`    Path: ${errorData.causalChain.map(e => e.event).join(' → ')}`);
                }
            }
        }

        logger.log('===================================\n');
    }

   
   
    for (const file of FILES) {
        const txtPath = CONFIG.resolveDocPath(file, 'txt');
        if (lazyFS.exists(txtPath).value) {
           
           
            fs.watch(txtPath, { persistent: true }, (eventType) => {
                if (eventType === 'change' && shouldProcessFileChange(txtPath)) {
                    logger.log(`${CONFIG.strings.watchPrefix} Detected change in ${file.txt}`);
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, CONFIG.watcher.postBuildDelay));
                        const buildId = `build-${file.txt}`;
                        pullGraph.invalidate(buildId);
                        await pullGraph.pull(buildId);
                        await new Promise(resolve => setTimeout(resolve, TIME.TICK));
                        renderView({ type: 'document-index' }, FILES);
                    })();
                }
            });
            
            fs.watchFile(txtPath, { interval: TIME.TICK }, (curr, prev) => {
                if (curr.mtime !== prev.mtime && shouldProcessFileChange(txtPath + '_watchfile')) {
                    logger.log(`${CONFIG.strings.watchFilePrefix} Detected change in ${file.txt}`);
                    (async () => {
                        await new Promise(resolve => setTimeout(resolve, CONFIG.watcher.postBuildDelay));
                        const buildId = `build-${file.txt}`;
                        pullGraph.invalidate(buildId);
                        await pullGraph.pull(buildId);
                        await new Promise(resolve => setTimeout(resolve, TIME.TICK));
                        renderView({ type: 'document-index' }, FILES);
                    })();
                }
            });
        }
    }
    
    logger.log(`${CONFIG.strings.watchingPrefix} ${FILES.map(f => f.txt).join(', ')}`);
    
   
    
   
    const heartbeatInterval = setInterval(() => {
       
        const uptime = Math.floor((Date.now() - processor.state.stats.uptime) / TIME.SECOND);
        
       
        if (CONFIG.debug.enableTelemetry) {
           
            (async () => {
                try {
                   
                    if (!traceOrchestrator.lazyTelemetry) {
                        traceOrchestrator.initializeLazyTelemetry();
                    }
                    
                   
                    const exportLazy = traceOrchestrator.lazyTelemetry.value.export;
                    await lazyFS.write(
                        path.join(__dirname, CONFIG.files.telemetryFile),
                        exportLazy.value.json.value
                    ).pull();
                } catch (error) {
                   
                    traceOrchestrator.error(error, { context: 'telemetry_export' });
                }
            })();
        }
    }, CONFIG.process.heartbeatInterval);
    
   
    if (!processor.state.intervals) processor.state.intervals = [];
    processor.state.intervals.push(heartbeatInterval);
}

// Handle uncaught exceptions gracefully
process.on(CONFIG.strings.exceptionEvent, (error) => {
    logger.error(CONFIG.strings.criticalErrorPrefix, error);
    traceOrchestrator.error(error, { type: CONFIG.strings.exceptionEvent });
   
});

process.on(CONFIG.strings.rejectionEvent, (reason, promise) => {
    logger.error(CONFIG.strings.unhandledRejectionPrefix, reason);
    traceOrchestrator.error(new Error(String(reason)), { 
        type: CONFIG.strings.rejectionEvent,
        promise: String(promise)
    });
   
});

process.on(CONFIG.strings.interruptSignal, async () => {
    logger.log('\n' + CONFIG.strings.shutdownMessage);
    
    lockManager.release();
    
   
    if (processor.state.intervals) {
        for (const interval of processor.state.intervals) {
            clearInterval(interval);
        }
    }
    
   
    for (const file of FILES) {
        const txtPath = path.join(__dirname, file.txt);
        if (lazyFS.exists(txtPath).value) {
            fs.unwatchFile(txtPath);
        }
    }
    
   
    try {
        const closePromises = [];
        
        for (const page of processor.state.pages.values()) {
            closePromises.push(page.close().catch(err => {
                logger.warn('[CLEANUP] Failed to close page:', err.message);
            }));
        }
        
        if (processor.state.browser) {
            closePromises.push(processor.state.browser.close().catch(err => {
                logger.warn('[CLEANUP] Failed to close browser:', err.message);
            }));
        }
        
       
        await Promise.race([
            Promise.all(closePromises),
            new Promise(resolve => setTimeout(resolve, TIME.TIMEOUT))
        ]);
    } catch (error) {
        logger.error(CONFIG.strings.shutdownBrowserErrorPrefix, error.message);
    }
    
    const uptime = Math.floor((Date.now() - processor.state.stats.uptime) / TIME.SECOND);
    
    process.exit(CONFIG.process.exitCode.success);
});

// INITIALIZATION

// Load configuration profile based on environment
const profile = process.env.NODE_ENV;
const loadedConfig = loadConfig(profile);

// Merge with existing CONFIG
Object.assign(CONFIG, loadedConfig);

// Validate configuration with schema (uses existing traceOrchestrator instance)
const validationResult = validateConfig();
if (validationResult.warnings.length > 0) {
}

// Removed BuildScheduler auto-scaling

// IPC Query Server - allows external processes to query running builder state
class QueryServer {
    constructor() {
        this.port = 9876;
        this.host = '127.0.0.1';
        this.server = null;
        this.connections = new Set();
        this.startTime = Date.now();
        this.rateLimitTokens = new Map();
    }

    checkRateLimit(ip) {
        const now = Date.now();
        const max = LIMITS.RATE_LIMIT_TOKENS;
        const b = this.rateLimitTokens.get(ip) || { tokens: max, last: now };
        b.tokens = Math.min(max, b.tokens + (now - b.last) / 100);
        b.last = now;
        if (b.tokens < 1) return false;
        b.tokens--;
        this.rateLimitTokens.set(ip, b);
        return true;
    }

   
    async stop() {
        if (!this.server) return;
        for (const s of this.connections) s.end();
        this.connections.clear();
        return new Promise(r => this.server.close(r));
    }

    async startWithRetry() {
        let port = this.port;
        for (let i = 0; i < LIMITS.PORT_BIND_RETRIES; i++) {
            try {
                await new Promise((ok, err) => {
                    this.server.listen(port, this.host, ok);
                    this.server.once('error', err);
                });
                this.port = port;
                fs.writeFileSync(path.join(os.homedir(), '.builder-trace-port'), String(port));
                logger.log(`[QUERY] Server listening at ${this.host}:${port}`);
                logger.log(`[QUERY] Use: node scripts/query.js health`);
                logger.log(`[QUERY] API sections: events, errors, perf, markov, build, memory, health, help`);
                traceOrchestrator.trace('QUERY_SERVER_STARTED', { port, host: this.host });
                return;
            } catch (e) {
                if (e.code === 'EADDRINUSE') { port++; continue; }
                throw e;
            }
        }
        throw new Error(`Port bind failed after ${LIMITS.PORT_BIND_RETRIES} attempts`);
    }

    start() {
        this.server = net.createServer((socket) => {
            this.connections.add(socket);
            traceOrchestrator.trace('QUERY_CONNECTION', { port: this.port });

            let buffer = '';

            socket.on('data', (data) => {
                buffer += data.toString();

               
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const query = JSON.parse(line);

                        if (typeof query.timestamp !== 'number') {
                            socket.write(JSON.stringify({ status: 400, error: 'Missing timestamp' }) + '\n');
                            continue;
                        }

                        const now = Date.now();
                        const age = now - query.timestamp;

                        if (age > 30000) {
                            socket.write(JSON.stringify({ status: 401, error: 'Timestamp too old' }) + '\n');
                            continue;
                        }

                        if (age < -5000) {
                            socket.write(JSON.stringify({ status: 401, error: 'Timestamp in future' }) + '\n');
                            continue;
                        }

                        const bodyStr = query.body ? JSON.stringify(query.body) : '';
                        const canonical = query.method + query.path + query.timestamp + bodyStr;
                        const expectedSig = crypto.createHmac('sha256', HMAC_KEY).update(canonical).digest('hex');

                        if (!crypto.timingSafeEqual(Buffer.from(query.signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
                            socket.write(JSON.stringify({ status: 403, error: 'Invalid signature' }) + '\n');
                            continue;
                        }

                        if (!this.checkRateLimit(socket.remoteAddress)) {
                            socket.write(JSON.stringify({ status: 429, error: 'Rate limit exceeded' }) + '\n');
                            continue;
                        }

                        const result = this.executeQuery(query);
                        socket.write(JSON.stringify(result) + '\n');
                    } catch (error) {
                        socket.write(JSON.stringify({
                            error: error.message,
                            stack: error.stack
                        }) + '\n');
                    }
                }
            });

            socket.on('end', () => {
                this.connections.delete(socket);
            });

            socket.on('error', (error) => {
                traceOrchestrator.error(error, { context: 'QUERY_SOCKET_ERROR' });
                this.connections.delete(socket);
            });
        });

        return this.startWithRetry();
    }

    executeQuery(query) {
        if (!query.method) {
            return {
                status: 400,
                error: 'Method required'
            };
        }

        if (!query.path) {
            return {
                status: 400,
                error: 'Path required'
            };
        }

        const { method, path: queryPath, body } = query;

        const api = this.buildQueryAPI();
        const [resource, ...pathParts] = queryPath.split('/').filter(p => p);

        if (!resource) {
            return {
                status: 400,
                error: 'Resource required',
                available: Object.keys(api)
            };
        }

        if (!api[resource]) {
            return {
                status: 404,
                error: `Resource not found: ${resource}`,
                available: Object.keys(api)
            };
        }

        try {
            let handler = api[resource];

           
            for (const part of pathParts) {
                if (typeof handler === 'function') {
                    break;
                }
                if (!handler[part]) {
                    return {
                        status: 404,
                        error: `Sub-resource not found: ${part}`,
                        available: Object.keys(handler)
                    };
                }
                handler = handler[part];
            }

           
            let result;
            if (method === 'GET') {
                if (typeof handler === 'function') {
                    result = handler(body);
                } else {
                    result = handler;
                }
            } else if (method === 'POST') {
                if (typeof handler !== 'function') {
                    return {
                        status: 405,
                        error: 'Method not allowed - POST requires function endpoint'
                    };
                }
                result = handler(body);
            } else if (method === 'PUT' || method === 'DELETE') {
                return {
                    status: 405,
                    error: `Method not implemented: ${method}`
                };
            } else {
                return {
                    status: 400,
                    error: `Invalid method: ${method}`
                };
            }

            const timestamp = Date.now();
            const age = timestamp - this.startTime;
            const responseData = {
                status: 200,
                data: result,
                meta: {
                    timestamp,
                    serverUptime: age
                }
            };

            // Two-hash orthogonal verification
            // Hash A: Hasher (HMAC-SHA256 with absorption)
            const hasher = new Hasher();
            hasher.absorb(responseData, 'response');
            const hasherHash = hasher.contentHash('query').value;

            // Hash B: HMAC-SHA3-256 (keyed verification path)
            const canonical = JSON.stringify(responseData);
            const sha3Hash = crypto.createHmac('sha3-256', HMAC_KEY).update(canonical).digest('hex');

            responseData.signature = hasherHash;
            responseData.verifyHash = sha3Hash;

            return responseData;
        } catch (error) {
            const timestamp = Date.now();
            const age = timestamp - this.startTime;
            const response = {
                status: 500,
                error: error.message,
                stack: error.stack,
                meta: {
                    timestamp,
                    serverUptime: age,
                    queryAge: 0
                }
            };
            const responseStr = JSON.stringify(response);
            const hmac = crypto.createHmac(CONFIG.strings.mainHashAlgorithm, HMAC_KEY);
            hmac.update(responseStr);
            response.signature = hmac.digest(CONFIG.strings.hashEncoding);
            return response;
        }
    }

    buildQueryAPI() {
        const requireParam = (paramName) => (body) => {
            if (!body || !body[paramName]) {
                throw new Error(`${paramName} required`);
            }
            return body[paramName];
        };

        const topN = (n) => (arr) => arr.slice(0, n);

        const mapEntries = (transformer) => (map) =>
            Array.from(map.entries()).map(([k, v]) => transformer(k, v));

        const countBy = (predicate) => (arr) => arr.filter(predicate).length;

        const resources = {
            events: {
                all: () => traceOrchestrator.events,
                recent: (n = 10) => traceOrchestrator.events.slice(-n),
                byType: (type) => traceOrchestrator.events.filter(e => e.event.includes(type)),
                count: () => traceOrchestrator.events.length
            },
            errors: {
                all: () => mapEntries((id, error) => ({
                    id,
                    message: error.error.message,
                    timestamp: error.timestamp,
                    stack: error.stack
                }))(traceOrchestrator.errors),
                count: () => traceOrchestrator.errors.size
            },
            perf: {
                slowest: (n = 10) => Pipeline.compose(
                    () => traceOrchestrator.getPerformanceProfile(),
                    topN(n)
                )(),
                metrics: () => traceOrchestrator.getMetrics()
            },
            markov: {
                explainFailure: (body) => {
                    if (!body) throw new Error('Request body required');
                    if (!body.errorId) throw new Error('errorId parameter required');
                    return traceOrchestrator.causalAnalysis.explainFailure(body.errorId);
                },
                predictors: (body) => {
                    const limit = body && body.limit !== undefined ? body.limit : CONFIG.reporting.defaultDisplayLimit;
                    if (typeof limit !== 'number') throw new Error('limit must be a number');
                    if (limit < 0) throw new Error('limit must be non-negative');

                    const patterns = traceOrchestrator.causalAnalysis.getFailurePredictors();
                    return patterns.slice(0, limit);
                },
                transitions: (body) => {
                    const limit = body && body.limit !== undefined ? body.limit : CONFIG.reporting.maxDisplayResults;
                    const minProbability = body && body.minProbability !== undefined ? body.minProbability : 0;

                    if (typeof limit !== 'number') throw new Error('limit must be a number');
                    if (limit < 0) throw new Error('limit must be non-negative');
                    if (typeof minProbability !== 'number') throw new Error('minProbability must be a number');
                    if (minProbability < 0 || minProbability > 1) throw new Error('minProbability must be between 0 and 1');

                    const matrix = traceOrchestrator.causalAnalysis.getTransitionMatrix();
                    return matrix.slice(0, limit).map(state => ({
                        ...state,
                        nextStates: state.nextStates.filter(t => t.probability >= minProbability)
                    }));
                },
                criticalPath: (body) => {
                    const includeContext = body && body.includeContext !== undefined ? body.includeContext : true;
                    if (typeof includeContext !== 'boolean') throw new Error('includeContext must be boolean');

                    const path = traceOrchestrator.causalAnalysis.getCriticalPath();
                    if (!includeContext) {
                        return {
                            totalDuration: path.totalDuration,
                            steps: path.steps.map(s => ({ event: s.event, duration: s.duration }))
                        };
                    }
                    return path;
                },
                bottlenecks: (body) => {
                    const limit = body && body.limit !== undefined ? body.limit : CONFIG.reporting.defaultDisplayLimit;
                    const minDuration = body && body.minDuration !== undefined ? body.minDuration : 0;
                    const minCount = body && body.minCount !== undefined ? body.minCount : 1;

                    if (typeof limit !== 'number') throw new Error('limit must be a number');
                    if (limit < 0) throw new Error('limit must be non-negative');
                    if (typeof minDuration !== 'number') throw new Error('minDuration must be a number');
                    if (minDuration < 0) throw new Error('minDuration must be non-negative');
                    if (typeof minCount !== 'number') throw new Error('minCount must be a number');
                    if (minCount < 1) throw new Error('minCount must be at least 1');

                    const bottlenecks = traceOrchestrator.causalAnalysis.getBottlenecks();
                    return bottlenecks
                        .filter(b => b.avgDuration >= minDuration && b.count >= minCount)
                        .slice(0, limit);
                },
                anomalies: (body) => {
                    const limit = body && body.limit !== undefined ? body.limit : CONFIG.reporting.defaultDisplayLimit;
                    const zScoreThreshold = body && body.zScoreThreshold !== undefined ? body.zScoreThreshold : CONFIG.markov.zScoreThreshold;

                    if (typeof limit !== 'number') throw new Error('limit must be a number');
                    if (limit < 0) throw new Error('limit must be non-negative');
                    if (typeof zScoreThreshold !== 'number') throw new Error('zScoreThreshold must be a number');
                    if (zScoreThreshold < 0) throw new Error('zScoreThreshold must be non-negative');

                    const anomalies = traceOrchestrator.causalAnalysis.getAnomalies();
                    return anomalies
                        .filter(a => Math.abs(parseFloat(a.zScore)) >= zScoreThreshold)
                        .slice(0, limit);
                }
            },
            build: {
                queue: () => ({
                    building: Array.from(processor.state.building),
                    errors: processor.state.errors,
                    buildsCompleted: processor.state.stats.builds,
                    uptimeMs: Date.now() - processor.state.stats.uptime
                }),
                status: () => ({
                    configured: FILES.map(f => f.name),
                    built: FILES.filter(f => fs.existsSync(CONFIG.resolveDocPath(f, 'html'))).map(f => f.name),
                    watching: FILES.map(f => f.txt)
                })
            },
            memory: {
                usage: () => process.memoryUsage(),
                pressure: () => traceOrchestrator.calculateMemoryPressure()
            },
            integrity: {
                verify: Pipeline.compose(
                    requireParam('clientSha3'),
                    requireParam('serverVerifyHash'),
                    requireParam('canonicalData'),
                    (body) => {
                        const recomputedHash = crypto.createHash('sha3-256')
                            .update(JSON.stringify(body.canonicalData))
                            .digest('hex');

                        const clientComputedCorrectly = recomputedHash === body.clientSha3;
                        const dataUnmodified = recomputedHash === body.serverVerifyHash;
                        const verified = clientComputedCorrectly && dataUnmodified;

                        const hasher = new Hasher();
                        hasher.verify(body.clientSha3, recomputedHash);

                        traceOrchestrator.trace('INTEGRITY_CHECK', {
                            match: verified,
                            clientHash: body.clientSha3
                        });

                        return {
                            verified,
                            tampered: !dataUnmodified,
                            receivedData: recomputedHash.slice(0, 16),
                            originalData: body.serverVerifyHash.slice(0, 16)
                        };
                    }
                )
            },
            telemetry: {
                export: () => traceOrchestrator.exportTelemetry(),
                metrics: () => {
                    const exported = traceOrchestrator.exportTelemetry();
                    return exported.metrics;
                },
                snapshot: () => {
                    const exported = traceOrchestrator.exportTelemetry();
                    return exported.raw;
                }
            },
            health: () => ({
                status: 'ok',
                uptime: Date.now() - this.startTime,
                connections: this.connections.size,
                eventsCount: traceOrchestrator.events.length,
                errorsCount: traceOrchestrator.errors.size,
                memoryUsage: process.memoryUsage()
            }),
            help: () => {
                const commands = [];

                for (const [section, endpoints] of Object.entries(resources)) {
                    if (section === 'help' || section === 'health') continue;
                    for (const endpoint of Object.keys(endpoints)) {
                        commands.push(`/${section}/${endpoint}`);
                    }
                }

                commands.push('/health');

                return {
                    title: 'HCT Builder Query API',
                    commands: commands.sort()
                };
            }
        };

        return resources;
    }

    stop() {
       
        for (const socket of this.connections) {
            socket.end();
        }
        this.connections.clear();

       
        if (this.server) {
            this.server.close();
        }
    }
}

export { Pipeline, Lazy, CONFIG, QueryServer, watch };

const isDirectExecution = import.meta.url.startsWith('file:') &&
    process.argv[1] &&
    (process.argv[1].endsWith('builder.js') || process.argv[1].endsWith('builder'));

if (isDirectExecution) {
    queryServer = new QueryServer();

    watch().catch(error => {
        logger.error(CONFIG.strings.startupFailedMessage, error);
        lockManager.release();
        process.exit(1);
    });
}
