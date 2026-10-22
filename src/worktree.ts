import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (await run('git', args, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();

/**
 * Plans a git worktree under `<CODEX_HOME>/worktrees/<id>/<repo>`, the layout the official Codex
 * clients use, from the current HEAD. Uncommitted changes stay in the original checkout.
 */
export async function planWorktree(root: string, codexHome: string, branch?: string) {
  let top: string;
  try {
    top = await git(root, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('This workspace is not inside a git repository.');
  }
  if (branch)
    try {
      await git(top, ['check-ref-format', '--branch', branch]);
    } catch {
      throw new Error(`"${branch}" is not a valid branch name.`);
    }
  // Pin the commit shown for confirmation, so a commit made meanwhile cannot change the base.
  const commit = await git(top, ['rev-parse', 'HEAD']);
  const dirty = (await git(top, ['status', '--porcelain'])).length > 0;
  const path = join(codexHome, 'worktrees', randomBytes(2).toString('hex'), basename(top));
  return {
    repository: top,
    head: commit.slice(0, 7),
    dirty,
    path,
    branch,
    create: () => git(top, ['worktree', 'add', ...(branch ? ['-b', branch] : ['--detach']), path, commit]),
  };
}
