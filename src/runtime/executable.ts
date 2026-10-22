import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';

export function windowsTarget(arch: string) {
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Unsupported Windows architecture.');
  return { package: `@openai/codex-win32-${arch}`, triple: `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc` };
}
export function windowsRuntimeCandidates(directory: string, arch: string) {
  const target = windowsTarget(arch),
    root = win32.join(directory, 'node_modules', '@openai', 'codex');
  return [
    win32.join(root, 'vendor', target.triple, 'bin', 'codex.exe'),
    win32.join(
      directory,
      'node_modules',
      '@openai',
      target.package.split('/')[1],
      'vendor',
      target.triple,
      'bin',
      'codex.exe',
    ),
  ];
}
export function runtimeExecutable(executable: string) {
  if (process.platform !== 'win32') return executable;
  const candidates =
    isAbsolute(executable) || executable.includes('/') || executable.includes('\\')
      ? [resolve(executable)]
      : (process.env.PATH ?? '')
          .split(';')
          .filter(Boolean)
          .flatMap(directory => [
            join(directory.replace(/^"|"$/g, ''), executable),
            join(directory.replace(/^"|"$/g, ''), `${executable}.exe`),
            join(directory.replace(/^"|"$/g, ''), `${executable}.cmd`),
          ]);
  const found = candidates.find(path => existsSync(path) && statSync(path).isFile());
  if (!found) throw new Error('Codex executable was not found on PATH.');
  if (/\.exe$/i.test(found)) return found;
  // Never run a .cmd through a shell: resolve the official npm native binary instead.
  const target = windowsTarget(process.arch),
    directory = dirname(found),
    paths = windowsRuntimeCandidates(directory, process.arch);
  try {
    const manifest = createRequire(join(directory, 'node_modules', '@openai', 'codex', 'package.json')).resolve(
      `${target.package}/package.json`,
    );
    paths.unshift(join(dirname(manifest), 'vendor', target.triple, 'bin', 'codex.exe'));
  } catch {
    /* Older official packages ship vendor/ inside @openai/codex. */
  }
  const binary = paths.find(path => existsSync(path) && statSync(path).isFile());
  if (!binary)
    throw new Error(
      'Set Runtime Path to the official codex.exe, or reinstall the official npm Codex package with optional dependencies.',
    );
  return binary;
}
