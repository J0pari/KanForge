// Ported from scripts/builder.js:4211-4329 (J0pari/Builder, MIT) via tools/extract_modules.py.
// Changed: plain sha256 hash chain (no HMAC secret) so statement pins are reproducible across
// machines/runs; Builder's CONFIG/HMAC_KEY/pullGraph/traceOrchestrator globals stripped.
// Chain behavior preserved: each contentHash incorporates the previous hash.

import crypto from 'node:crypto';
import { Lazy } from './lazy.js';

export class Hasher {
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

            const hasher = crypto.createHash('sha256');

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

            const hash = hasher.digest('hex');
            this.lastHash = hash;

            return hash;
        });
    }

    verify(clientHash, serverHash) {
        return clientHash === serverHash;
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
