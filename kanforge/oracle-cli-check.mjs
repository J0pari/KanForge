import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from './env.js';

function libDirs(leanProject) {
    const dirs = [];
    const root = path.join(leanProject, '.lake', 'build', 'lib', 'lean');
    if (fs.existsSync(root)) dirs.push(root);
    let packages;
    try {
        packages = fs.readdirSync(path.join(leanProject, '.lake', 'packages'));
    } catch {
        return dirs;
    }
    for (const pkg of packages) {
        const dir = path.join(leanProject, '.lake', 'packages', pkg, '.lake', 'build', 'lib', 'lean');
        if (fs.existsSync(dir)) dirs.push(dir);
    }
    return dirs;
}

const E = loadEnv();
const dirs = libDirs(E.KANFORGE_LEAN_PROJECT);
const env = { ...process.env };
if (dirs.length) env.LEAN_PATH = dirs.join(path.delimiter);
const leanBin = E.KANFORGE_LEAN_BIN;

const file = path.resolve('../../oracle/erdos10-two-pows/oracle.lean');
fs.appendFileSync('oracle-cli.log', 'checking via lean CLI: ' + file + '\n');
const child = spawn(leanBin, [file], { env });
let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });
child.on('close', code => {
    fs.appendFileSync('oracle-cli.log', 'exit=' + code + '\n' + out.slice(0, 4000) + '\n');
    process.exit(0);
});
child.on('error', err => {
    fs.appendFileSync('oracle-cli.log', 'SPAWN ERROR: ' + err.message + '\n');
    process.exit(1);
});
