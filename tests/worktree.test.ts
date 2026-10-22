import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { planWorktree } from '../src/worktree';

test('worktrees start from HEAD under CODEX_HOME/worktrees and leave uncommitted changes behind', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'codex-worktree-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo'),
    home = join(temp, 'home');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
  execFileSync('git', ['init', '-q', repo]);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  await writeFile(join(repo, 'dirty.txt'), 'local');
  await assert.rejects(planWorktree(temp, home), /not inside a git repository/);
  await assert.rejects(planWorktree(repo, home, 'bad..name'), /not a valid branch/);
  const plan = await planWorktree(repo, home, 'feature/side');
  assert.equal(plan.dirty, true);
  assert.match(relative(join(home, 'worktrees'), plan.path).split(sep).join('/'), /^[0-9a-f]{4}\/repo$/);
  await plan.create();
  assert.equal(
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: plan.path }).toString().trim(),
    'feature/side',
  );
  assert.equal(existsSync(join(plan.path, 'dirty.txt')), false);
  const detached = await planWorktree(repo, home);
  await detached.create();
  assert.equal(
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: detached.path }).toString().trim(),
    'HEAD',
  );
});
