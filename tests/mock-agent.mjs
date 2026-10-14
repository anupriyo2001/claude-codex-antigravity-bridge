// Test-only fake worker. Used only when AGENT_BRIDGE_ENABLE_MOCK=1.
// argv: <behaviour> <stage dir> <last-message file>
import fs from 'node:fs';
import path from 'node:path';

const [behaviour, stage, last] = process.argv.slice(2);
const good = { summary: 'mock ok', findings: [{ severity: 'info', file: null, line: null, message: 'mock finding' }], warnings: [], recommended_next_action: 'none' };

switch (behaviour) {
  case 'ok': fs.writeFileSync(last, JSON.stringify(good)); break;
  case 'custom': {
    const imgs = fs.existsSync(path.join(stage, '_images')) ? fs.readdirSync(path.join(stage, '_images')) : [];
    fs.writeFileSync(last, JSON.stringify({ summary: `saw ${imgs.length} image(s)`, picks: imgs }));
    break;
  }
  case 'write': {
    const f = fs.readdirSync(stage).find((n) => n.endsWith('.txt'));
    if (f) fs.appendFileSync(path.join(stage, f), `edited by mock pid ${process.pid}\n`);
    fs.writeFileSync(path.join(stage, `new-${process.pid}.txt`), 'created by mock\n');
    fs.writeFileSync(last, JSON.stringify(good));
    break;
  }
  case 'crash': process.stderr.write('mock: segmentation fault (simulated)\n'); process.exit(139); break;
  case 'malformed': fs.writeFileSync(last, 'Sure! Here is my answer: {not json'); break;
  case 'wrongshape': fs.writeFileSync(last, JSON.stringify({ answer: 42 })); break;
  case 'hang': setInterval(() => {}, 1000); break;
  case 'auth': process.stderr.write('Error: not logged in. Run login first.\n'); process.exit(1); break;
  case 'limit': process.stderr.write("You've hit your usage limit. Try again in 2 hours.\n"); process.exit(1); break;
  case 'badmodel': process.stderr.write('model mock-x is not recognized as a known model\n'); process.exit(1); break;
  default: process.exit(2);
}
