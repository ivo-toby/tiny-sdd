import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [candidateArg, outputArg, mode = 'all'] = process.argv.slice(2);
if (!candidateArg || !outputArg || !['all', 'checks'].includes(mode)) throw new Error('Usage: verify.mjs CANDIDATE NEW_OUTPUT [all|checks]');
const candidate = resolve(candidateArg);
const output = resolve(outputArg);
if (!(await lstat(candidate)).isDirectory() || (await lstat(candidate)).isSymbolicLink()) throw new Error('Candidate must be a regular directory');
await mkdir(output, { recursive: false, mode: 0o700 });
const nodeRoot = dirname(dirname(process.execPath));
const args = ['--unshare-all', '--die-with-parent', '--new-session',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/verifier',
  '--ro-bind', nodeRoot, '/opt/node', '--ro-bind', candidate, '/work', '--ro-bind', join(here, 'checks'), '/checks',
  '--chdir', '/work', '/opt/node/bin/node', '--test', '--test-reporter=tap',
  ...(mode === 'all' ? ['test/*.test.mjs'] : []), '/checks/store.test.mjs'];
const child = spawn('/usr/bin/bwrap', args, { env: { PATH: '/opt/node/bin:/usr/bin:/bin', HOME: '/home/verifier', TMPDIR: '/tmp' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false, outputLimited = false;
const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
const add = (which, chunk) => {
  if (stdout.length + stderr.length > 4 * 1024 * 1024) { outputLimited = true; stop(); return; }
  if (which === 'stdout') stdout += chunk; else stderr += chunk;
};
child.stdout.on('data', chunk => add('stdout', chunk));
child.stderr.on('data', chunk => add('stderr', chunk));
const timer = setTimeout(() => { timedOut = true; stop(); }, 60000);
const result = await new Promise(resolveResult => {
  child.on('error', error => resolveResult({ exitCode: null, error: error.message }));
  child.on('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
});
clearTimeout(timer);
Object.assign(result, { timedOut, outputLimited, pass: result.exitCode === 0 && !timedOut && !outputLimited, candidate, mode });
await writeFile(join(output, 'stdout.txt'), stdout, { mode: 0o600 });
await writeFile(join(output, 'stderr.txt'), stderr, { mode: 0o600 });
await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
process.exitCode = result.pass ? 0 : 1;
