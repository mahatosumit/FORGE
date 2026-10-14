// pack-echo sidecar — JSON-lines protocol: reads {id, proposal} frames from
// stdin, replies {id, ok, observation} on stdout. One dispatch per process.
import { createHash } from 'node:crypto';
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('
')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    const bytes = new TextEncoder().encode('echo: ' + JSON.stringify(frame.proposal));
    const hash = createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(JSON.stringify({ id: frame.id, ok: true, observation: {
      hash, bytes: bytes.byteLength, sourcePath: null,
    } }) + '
');
    process.exit(0);
  }
});
