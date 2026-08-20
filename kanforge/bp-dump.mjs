import fs from 'node:fs';
const t = fs.readFileSync('runs/erdos10-variant-two-pows/blueprint.md', 'utf8');
for (const s of t.split('### ').slice(1)) {
    const name = s.slice(0, 14).trim();
    const m = s.match(/```lean\n([\s\S]*?)```/);
    const stmt = (m ? m[1] : '');
    const body = stmt.split('\n').filter(l => !l.startsWith('import') && !l.trim().startsWith('theorem erdos_10')).join(' ').trim();
    const depLine = s.match(/- Deps: ([^\n]*)/);
    console.log('==', name, '| deps:', depLine ? depLine[1].slice(0, 44) : '(root)');
    console.log(body.slice(0, 240));
    console.log();
}
