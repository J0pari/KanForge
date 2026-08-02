// Real config loader for tests: reads the git-ignored kanforge/.env (KEY=VALUE, comments and
// quotes tolerated) and overlays process.env on top. This is how live suites get the real
// repl binary path and the real LLM key — never a fake or hardcoded fixture.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadDotEnv(file) {
    const env = {};
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return env;
    }
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    return env;
}

export const ENV = { ...loadDotEnv(fileURLToPath(new URL('../.env', import.meta.url))), ...process.env };
