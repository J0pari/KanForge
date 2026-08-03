// Environment loader: parse the package-local .env (git-ignored) into process.env.
// Existing process.env values win — real environment variables always override the file.
// Shared by bench/, query/, and the live test suites so there is exactly one place that
// knows where configuration lives.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv({ path: envPath = path.join(PACKAGE_ROOT, '.env'), override = false } = {}) {
    if (fs.existsSync(envPath)) {
        for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const key = line.slice(0, eq).trim();
            const value = line.slice(eq + 1).trim();
            if (override || process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    }
    return process.env;
}
