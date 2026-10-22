import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';

export function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}
export function attachable(path: string) {
  const parts = path.split(/[\/\\]/);
  if (parts.some(p => /^\.(?:git|hg|svn|ssh|codex|aws|azure|kube|gnupg|docker)$/i.test(p))) return false;
  const name = parts.at(-1) ?? '';
  return !/^(?:\.env(?:\..*)?|\.(?:netrc|git-credentials|npmrc|pypirc|authinfo)|auth\.json|credentials(?:\.(?:json|ya?ml|toml|ini|xml|csv|txt))?|secrets\.(?:json|ya?ml|toml|ini)|service[-_]account(?:[-_].*)?\.json|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|tfstate)(?:\.backup)?)$/i.test(
    name,
  );
}

export async function workspaceTextPath(root: string, path: string, allowMissing = false) {
  const parts = path.split('/');
  if (
    !path ||
    path.length > 512 ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    parts.some(p => !p || p === '.' || p === '..' || /^\.(?:git|hg|svn|codex|ssh)$/i.test(p)) ||
    !attachable(path)
  )
    throw new Error('Review requires a non-credential text file inside the workspace.');
  if ((await realpath(root).catch(() => undefined)) !== root)
    throw new Error('Workspace root changed. Reopen the workspace.');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(join(root, ...parts.slice(0, i))).catch(error => {
      if (allowMissing && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) return join(root, path);
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1))
      throw new Error('Review does not support links or non-regular files.');
  }
  const full = join(root, path);
  if ((await realpath(full)) !== full) throw new Error('Review path changed.');
  return full;
}

export async function readWorkspaceText(root: string, path: string) {
  const full = await workspaceTextPath(root, path);
  const file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 400_000)
      throw new Error('Review supports UTF-8 text files under 100,000 characters.');
    const bytes = await file.readFile();
    const text = bytes.toString('utf8'),
      after = await file.stat(),
      current = await lstat(full);
    if (text.length > 100_000 || bytes.includes(0) || !Buffer.from(text).equals(bytes))
      throw new Error('Review supports small valid UTF-8 text files.');
    if (
      after.nlink !== 1 ||
      current.nlink !== 1 ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.isSymbolicLink() ||
      current.ino !== after.ino ||
      current.dev !== after.dev ||
      (await realpath(full)) !== full
    )
      throw new Error('File changed while reading. Retry with a new proposal.');
    return { full, text, identity: `${after.dev}:${after.ino}` };
  } finally {
    await file.close();
  }
}
