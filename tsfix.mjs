import fs from 'node:fs';

const repl = fs.readFileSync('kanforge/lean/backendRepl.js', 'utf8');
const replOut = repl.replace(/console\.log\(`\[repl-pool\]/g, 'console.log(`[${ts()}] [repl-pool]');
fs.writeFileSync('kanforge/lean/backendRepl.js', replOut);

const loop = fs.readFileSync('kanforge/agent/loop.js', 'utf8');
const loopOut = loop.replace(/console\.log\(`\[loop\]/g, 'console.log(`[${ts()}] [loop]');
fs.writeFileSync('kanforge/agent/loop.js', loopOut);

console.log('done');
