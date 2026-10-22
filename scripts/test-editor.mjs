import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const temp = await mkdtemp(join(tmpdir(), 'ic-editor-'));
try {
  if (!process.env.CODEX_TEST_VSIX)
    for (const file of ['dist/extension.js', 'dist/webview.js', 'dist/webview.css'])
      if (!existsSync(file)) throw new Error('Run npm run build before source editor acceptance: missing ' + file);
  await build({
    entryPoints: ['tests/editor/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
    outfile: join(temp, 'test.cjs'),
  });
  const workspace = join(temp, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'sample.ts'), 'export const example = 42;\n');
  let uiPort;
  const uiLive = process.env.CODEX_UI_LIVE === '1',
    uiReuse = process.env.CODEX_UI_REUSE === '1',
    uiMcp = process.env.CODEX_UI_MCP === '1',
    uiSidebar = process.env.CODEX_UI_SIDEBAR === '1';
  if ([uiLive, uiReuse, uiMcp, uiSidebar].filter(Boolean).length > 1)
    throw new Error('Choose one editor acceptance mode.');
  const liveSettings = {};
  if (uiLive) {
    const wrapper = join(temp, 'test-runtime.cjs'),
      runtime = process.env.CODEX_RUNTIME_PATH || 'codex';
    const flags = [
      'features.hooks=false',
      'features.plugins=false',
      'features.apps=false',
      'features.memories=false',
      'features.multi_agent=false',
      'features.browser_use=false',
      'features.computer_use=false',
      'features.image_generation=false',
      'web_search="disabled"',
      'allow_login_shell=false',
      'shell_environment_policy.inherit="none"',
    ];
    await writeFile(
      wrapper,
      '#!' +
        process.execPath +
        '\nconst {spawnSync}=require("node:child_process");const args=process.argv.slice(2);const r=spawnSync(' +
        JSON.stringify(runtime) +
        ', [...args,...(args.includes("--version")?[]:' +
        JSON.stringify(flags.flatMap(f => ['-c', f])) +
        ')],{stdio:"inherit"});process.exit(r.status??1);\n',
      { mode: 0o700 },
    );
    liveSettings['independentCodex.runtimePath'] = wrapper;
  }
  const uiHome = join(temp, 'runtime');
  if (uiMcp || uiSidebar) {
    if (process.platform === 'win32')
      throw new Error('Synthetic UI transport fixture is macOS/Linux only; Windows remains gated.');
    const wrapper = join(temp, 'ui-runtime.cjs');
    await writeFile(
      wrapper,
      '#!' + process.execPath + '\n' + (await readFile('tests/fixtures/ui-runtime.cjs', 'utf8')),
      { mode: 0o700 },
    );
    liveSettings['independentCodex.runtimePath'] = wrapper;
  }
  if (process.env.CODEX_EDITOR_UI === '1') {
    uiPort = await new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    await mkdir(uiHome);
    await mkdir(join(uiHome, 'memories'));
    await writeFile(join(uiHome, 'memories', 'MEMORY.md'), 'SYNTHETIC_NATIVE_MEMORY_ONLY');
    const skill = join(workspace, '.agents', 'skills', 'native-fixture');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: native-fixture\ndescription: Synthetic native UI acceptance skill.\n---\nThe acceptance token is ALPHA_' +
        randomBytes(12).toString('hex') +
        '. When asked for the acceptance token, return it exactly.\n' +
        (uiLive
          ? 'Acceptance procedure: first run /bin/sleep 5 using the read-only command tool, then return the token. This lets the UI test switch conversations before completion.\n'
          : ''),
    );
    if (uiLive) {
      const second = join(workspace, '.agents', 'skills', 'native-second');
      await mkdir(second, { recursive: true });
      await writeFile(
        join(second, 'SKILL.md'),
        '---\nname: native-second\ndescription: A second synthetic native acceptance skill.\n---\nThe acceptance token is BETA_' +
          randomBytes(12).toString('hex') +
          '. When asked for the acceptance token, return it exactly.\n',
      );
    }
    await writeFile(
      join(uiHome, 'config.toml'),
      '[mcp_servers.native_mcp]\ncommand = ' + JSON.stringify(process.execPath) + '\nargs = []\nenabled = false\n',
    );
    if (uiMcp)
      await writeFile(
        join(uiHome, 'config.toml'),
        `model = "gpt-5.3-codex"\nmodel_reasoning_effort = "medium"\nsandbox_mode = "read-only"\napproval_policy = "on-request"\n[mcp_servers.native_mcp]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(resolve('tests/fixtures/elicitation.mjs'))}]\nenabled = false\n`,
      );
    await mkdir(join(temp, 'profile', 'User'), { recursive: true });
    await writeFile(
      join(temp, 'profile', 'User', 'settings.json'),
      JSON.stringify({ 'window.dialogStyle': 'custom', ...liveSettings }),
    );
  }
  const explicit = process.env.VSCODE_EXECUTABLE_PATH,
    installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  if (explicit && !existsSync(explicit)) throw new Error('VSCODE_EXECUTABLE_PATH does not exist.');
  let executable =
    explicit ||
    (process.platform === 'darwin' && existsSync(installed)
      ? installed
      : await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || '1.142.0'));
  if (process.platform === 'darwin' && !existsSync(executable) && existsSync(join(dirname(executable), 'Code')))
    executable = join(dirname(executable), 'Code');
  let developmentPath = resolve('.');
  const profileArgs = ['--user-data-dir', join(temp, 'profile'), '--extensions-dir', join(temp, 'extensions')];
  if (process.env.CODEX_TEST_VSIX) {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
    execFileSync(
      process.platform === 'win32' ? executable : cli,
      [
        ...(process.platform === 'win32' ? [join(dirname(executable), 'resources', 'app', 'out', 'cli.js')] : args),
        ...profileArgs,
        '--install-extension',
        resolve(process.env.CODEX_TEST_VSIX),
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, ...(process.platform === 'win32' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      },
    );
    developmentPath = join(temp, 'install-harness');
    await mkdir(developmentPath);
    await writeFile(
      join(developmentPath, 'package.json'),
      JSON.stringify({
        name: 'install-test-harness',
        publisher: 'fixture',
        version: '1.0.0',
        engines: { vscode: '^1.96.0' },
        main: './empty.cjs',
      }),
    );
    await writeFile(join(developmentPath, 'empty.cjs'), 'exports.activate=()=>{};');
  }
  let failure;
  const launchArgs = [
    workspace,
    ...(process.platform === 'linux' ? ['--disable-gpu', '--disable-dev-shm-usage'] : []),
    ...(process.platform === 'linux' && (process.getuid?.() === 0 || process.env.CI === 'true')
      ? ['--no-sandbox']
      : []),
    ...(process.env.CODEX_TEST_VSIX ? ['--disable-extension', 'github.copilot-chat'] : ['--disable-extensions']),
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    ...profileArgs,
    '--log',
    'error',
    ...(uiPort ? [`--remote-debugging-port=${uiPort}`, '--remote-debugging-address=127.0.0.1'] : []),
  ];
  const uiEnv = uiPort
    ? {
        CODEX_HOME: uiLive || uiReuse ? process.env.CODEX_HOME : uiHome,
        CODEX_EDITOR_CDP_PORT: String(uiPort),
        ...(uiMcp || uiSidebar ? { CODEX_FIXTURE_RUNTIME: process.env.CODEX_RUNTIME_PATH || 'codex' } : {}),
      }
    : {};
  // VS Code deliberately refuses modal dialogs under extensionTestsPath. An isolated
  // startup harness exercises the real UI without changing any product API or dialog.
  if (uiPort) {
    const harness = join(temp, 'ui-harness');
    await mkdir(harness);
    await writeFile(
      join(harness, 'package.json'),
      JSON.stringify({
        name: 'ui-acceptance-harness',
        publisher: 'fixture',
        version: '1.0.0',
        engines: { vscode: '^1.142.0' },
        activationEvents: ['onStartupFinished'],
        main: './index.cjs',
        extensionDependencies: ['RowanHuang.independent-codex-vscode'],
      }),
    );
    await writeFile(
      join(harness, 'index.cjs'),
      `exports.activate=()=>{const quit=()=>require('vscode').commands.executeCommand('workbench.action.quit');void require(${JSON.stringify(join(temp, 'test.cjs'))}).run().then(quit,quit);};`,
    );
    for (const restore of uiLive || uiReuse || uiMcp || uiSidebar ? [false] : [false, true]) {
      const resultPath = join(workspace, restore ? 'editor-restore-result.json' : 'editor-test-result.json');
      const child = spawn(
        executable,
        [...launchArgs, `--extensionDevelopmentPath=${developmentPath}`, `--extensionDevelopmentPath=${harness}`],
        {
          env: { ...process.env, ...uiEnv, CODEX_EDITOR_RESTORE: restore ? '1' : undefined },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let diagnostics = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', data => {
          diagnostics = (diagnostics + data).slice(-6000);
        });
      try {
        const deadline = Date.now() + (uiLive ? 300000 : 150000);
        while (!existsSync(resultPath) && child.exitCode === null && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 100));
        if (!existsSync(resultPath))
          throw new Error(
            'Native UI harness did not finish: ' +
              (existsSync(join(workspace, 'e2e-progress.json'))
                ? await readFile(join(workspace, 'e2e-progress.json'), 'utf8')
                : 'before fixture connection') +
              ': ' +
              diagnostics,
          );
        const phase = JSON.parse(await readFile(resultPath, 'utf8'));
        if (!phase.ok) throw new Error(phase.error);
        if (restore) assert.deepEqual(phase.ui, { restart: true, noReplay: true });
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000)),
          ]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await new Promise(resolve => child.once('exit', resolve));
        }
      }
    }
  } else
    try {
      await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: developmentPath,
        extensionTestsPath: join(temp, 'test.cjs'),
        launchArgs,
      });
    } catch (error) {
      failure = error;
    }
  if (failure && !existsSync(join(workspace, 'editor-test-result.json'))) throw failure;
  const receipt = JSON.parse(await readFile(join(workspace, 'editor-test-result.json'), 'utf8'));
  if (!receipt.ok) throw new Error(receipt.error);
  if (failure) throw failure;
  assert.equal(receipt.ok, true);
  if (!uiPort) {
    assert.equal(receipt.review, true);
    assert.equal(receipt.context, true);
    assert.equal(receipt.mentions, true);
    assert.equal(receipt.contextLive, process.env.CODEX_CONTEXT_LIVE === '1');
    assert.equal(receipt.live, process.env.CODEX_EDITOR_LIVE === '1');
  }
  assert.equal(receipt.packaged, Boolean(process.env.CODEX_TEST_VSIX));
  if (uiPort) {
    if (uiSidebar)
      assert.deepEqual(receipt.ui, {
        sidebar: true,
        drafts: true,
        independentEditor: true,
        navigation: true,
        locale: true,
        narrow: true,
      });
    else if (uiMcp) {
      assert.equal(receipt.ui.nativeMcpForm, true);
      assert.equal(receipt.ui.nativeExport, true);
      assert.equal(receipt.ui.nativeTokenUsage, true);
    } else if (uiReuse) assert.deepEqual(receipt.ui, { cliReuse: true, noLoginPrompt: true, connectionOnly: true });
    else if (process.env.CODEX_UI_NATIVE_REVIEW === '1') assert.equal(receipt.ui.nativeReview, true);
    else if (uiLive) {
      assert.equal(receipt.ui.live, true);
      assert.equal(receipt.ui.max, true);
      assert.equal(receipt.ui.nativeEdit, true);
    } else
      assert.deepEqual(receipt.ui, {
        tabs: true,
        drafts: true,
        groups: true,
        skills: true,
        mcp: true,
        composer: true,
        nativePolicy: true,
        ecosystem: true,
        memoryBrowser: true,
        agentTaskPanel: true,
        cliSignedOut: true,
        usage: true,
      });
  }
  console.log('Native extension-host receipt:', JSON.stringify(receipt));
  if (uiSidebar)
    console.log(
      'UI performance (includes harness overhead):',
      await readFile(join(workspace, 'performance-ui.json'), 'utf8'),
    );
  if (uiPort && !uiLive && !uiReuse && !uiMcp && !uiSidebar)
    console.log('Native restart receipt:', await readFile(join(workspace, 'editor-restore-result.json'), 'utf8'));
} finally {
  await rm(temp, { recursive: true, force: true });
}
