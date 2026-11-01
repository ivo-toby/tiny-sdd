import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCheckGit } from '../src/check-tools.mjs';

// A fake git installation: bin/git is a script that answers --exec-path and,
// like dyld with DYLD_PRINT_SEARCHING, reports one library through a symlink.
async function fakeInstall({ exitCode = 0 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tinysdd-check-tools-')));
  const prefix = join(root, 'Cellar', 'git', '1.0');
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await mkdir(join(prefix, 'libexec', 'git-core'), { recursive: true });
  await mkdir(join(prefix, 'share', 'git-core', 'templates'), { recursive: true });
  await mkdir(join(root, 'Cellar', 'pcre2', 'lib'), { recursive: true });
  await writeFile(join(root, 'Cellar', 'pcre2', 'lib', 'libpcre2.dylib'), '');
  await mkdir(join(root, 'opt'));
  await symlink(join(root, 'Cellar', 'git', '1.0'), join(root, 'opt', 'git'));
  await symlink(join(root, 'Cellar', 'pcre2'), join(root, 'opt', 'pcre2'));
  await mkdir(join(root, 'bin'));
  const git = join(prefix, 'bin', 'git');
  await writeFile(git, [
    '#!/bin/sh',
    `[ "$1" = "--exec-path" ] || exit 2`,
    `echo 'dyld[1]: find path "${root}/opt/pcre2/lib/libpcre2.dylib"' >&2`,
    `echo 'dyld[1]:   found: dylib-from-disk: "${root}/opt/pcre2/lib/libpcre2.dylib"' >&2`,
    `echo 'dyld[1]:   found: dylib-from-disk: "/usr/lib/libz.1.dylib"' >&2`,
    `echo '${root}/opt/git/libexec/git-core'`,
    `exit ${exitCode}`,
    '',
  ].join('\n'));
  await chmod(git, 0o755);
  await symlink(git, join(root, 'bin', 'git'));
  return { root, prefix, git };
}

test('no git on the controller PATH, or git turned off, provides no git', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'tinysdd-check-tools-empty-'));
  try {
    assert.equal(await resolveCheckGit({ platform: 'darwin', searchPath: `${empty}:relative/bin` }), null);
    assert.equal(await resolveCheckGit({ platform: 'linux', gitPath: null, searchPath: '/usr/bin:/bin' }), null);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('a git found on PATH is granted at its real installation, with the libraries and exec path it reports', async () => {
  const { root, prefix, git } = await fakeInstall();
  try {
    const resolved = await resolveCheckGit({ platform: 'darwin', searchPath: `/nonexistent:${join(root, 'bin')}` });
    assert.deepEqual(resolved, {
      executable: git,
      binDir: join(prefix, 'bin'),
      // As git reports it (through opt/) and as it resolves.
      execPaths: [join(root, 'opt', 'git', 'libexec', 'git-core'), join(prefix, 'libexec', 'git-core')],
      // System libraries are already readable; a symlinked one is granted both ways.
      libraries: [join(root, 'opt', 'pcre2', 'lib', 'libpcre2.dylib'), join(root, 'Cellar', 'pcre2', 'lib', 'libpcre2.dylib')],
      readable: [join(root, 'opt', 'git', 'share', 'git-core'), join(prefix, 'share', 'git-core')],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a host git the sandbox cannot provide fails the check clearly instead of hiding git', async () => {
  const { root, git } = await fakeInstall();
  const broken = await fakeInstall({ exitCode: 1 });
  try {
    // bubblewrap binds only /usr and /bin, so a git elsewhere cannot run there.
    await assert.rejects(resolveCheckGit({ platform: 'linux', searchPath: join(root, 'bin') }), (error) => error.code === 'CHECK_TOOL_UNAVAILABLE' && error.details.path === git && /outside \/usr and \/bin/u.test(error.message));
    await assert.rejects(resolveCheckGit({ platform: 'darwin', searchPath: join(broken.root, 'bin') }), (error) => error.code === 'CHECK_TOOL_UNAVAILABLE' && /does not run on this host/u.test(error.message));
    await assert.rejects(resolveCheckGit({ platform: 'darwin', gitPath: join(root, 'missing') }), (error) => error.code === 'CHECK_TOOL_UNAVAILABLE');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(broken.root, { recursive: true, force: true });
  }
});
