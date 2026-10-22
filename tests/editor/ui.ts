import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

type Frame = { sessionId: string; contextId?: number };
class Cdp {
  readonly contexts = new Map<string, Set<number>>();
  private next = 0;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const response = JSON.parse(String(event.data));
      if (response.method === 'Runtime.executionContextCreated') {
        if (!this.contexts.has(response.sessionId)) this.contexts.set(response.sessionId, new Set());
        this.contexts.get(response.sessionId)!.add(response.params.context.id);
      }
      if (response.method === 'Runtime.executionContextDestroyed')
        this.contexts.get(response.sessionId)?.delete(response.params.executionContextId);
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Editor debugger closed'));
      }
      this.pending.clear();
    });
  }
  request(method: string, params: unknown = {}, sessionId?: string): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Editor debugger timed out: ' + method));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async evaluate(frame: Frame, expression: string) {
    const response = await this.request(
      'Runtime.evaluate',
      { expression, contextId: frame.contextId, returnByValue: true, awaitPromise: true },
      frame.sessionId,
    );
    if (response.exceptionDetails)
      throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description ?? ''));
    return response.result.value;
  }
  close() {
    this.socket.close();
  }
}
async function until<T>(read: () => Promise<T>, message: string, timeout = 15000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(message);
}
export async function nativeUiTests(root: string) {
  const port = process.env.CODEX_EDITOR_CDP_PORT;
  assert.ok(port, 'Native UI tests require their isolated editor CDP port');
  const endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Cannot connect to test editor debugger')), { once: true });
  });
  const cdp = new Cdp(socket);
  try {
    await vscode.workspace
      .getConfiguration('independentCodex')
      .update('locale', 'en', vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    const firstOpenStarted = performance.now();
    await vscode.commands.executeCommand('independentCodex.editor');
    const sessions = new Map<string, string>();
    const targets = async () => {
      const result = await cdp.request('Target.getTargets');
      for (const target of result.targetInfos)
        if (['page', 'iframe'].includes(target.type) && !sessions.has(target.targetId)) {
          try {
            const sessionId = (await cdp.request('Target.attachToTarget', { targetId: target.targetId, flatten: true }))
              .sessionId;
            sessions.set(target.targetId, sessionId);
            await cdp.request('Runtime.enable', {}, sessionId);
          } catch {
            /* A transient webview target can close during setup. */
          }
        }
      return [...sessions.values()].flatMap(sessionId => [
        { sessionId },
        ...[...(cdp.contexts.get(sessionId) ?? [])].map(contextId => ({ sessionId, contextId })),
      ]);
    };
    const frame = await until(async () => {
      const visible: { session: Frame; width: number }[] = [];
      for (const session of await targets()) {
        try {
          const width = await cdp.evaluate(
            session,
            `document.querySelector('#root .app')&&document.visibilityState==='visible'?innerWidth:0`,
          );
          if (width) visible.push({ session, width });
        } catch {}
      }
      return visible.sort((a, b) => b.width - a.width)[0]?.session;
    }, 'Actual VS Code webview did not render');
    const workbench = await until(async () => {
      for (const session of await targets()) {
        try {
          if (await cdp.evaluate(session, `Boolean(document.querySelector('.monaco-workbench'))`)) return session;
        } catch {}
      }
      return undefined;
    }, 'Workbench target missing');
    await cdp.request('Page.bringToFront', {}, workbench.sessionId);
    const read = (expression: string) => cdp.evaluate(frame, expression);
    // Chat actions live in the header "More actions" menu; other views live in its Settings page.
    const menuItems = ['Copy chat as Markdown', 'Export chat to document', 'Archive current chat', 'Settings'];
    const hubItems = [
      'Skills',
      'MCP',
      'Tasks',
      'Memories',
      'Usage',
      'Ecosystem',
      'Permissions and runtime',
      'New group',
    ];
    const openMenu = `const m=document.querySelector('[aria-label="More actions"]');if(m&&!document.querySelector('.menu'))m.click();`;
    const openHub = `const s=[...document.querySelectorAll('.menu button')].find(e=>e.textContent.trim()==='Settings');if(s)s.click();else{${openMenu}}`;
    const click = async (label: string) => {
      if (label === 'Chat')
        return until(
          () =>
            read(
              `(()=>{const b=document.querySelector('[aria-label="Back to chat"],[aria-label="Back to settings"]');if(!b)return true;b.click();return false})()`,
            ),
          'Could not return to chat',
        );
      if (label === 'New chat tab' && !(await read(`Boolean(document.querySelector('[aria-label="New chat tab"]'))`)))
        label = 'New chat';
      const find = `([...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)}))`;
      const reveal = hubItems.includes(label) ? openHub : menuItems.includes(label) ? openMenu : '';
      return until(
        () =>
          read(
            `(()=>{const button=${find};if(!button||button.disabled){${reveal}return false}button.click();return true})()`,
          ),
        'Unavailable button: ' + label,
      );
    };
    const clickCheckbox = () =>
      until(
        () =>
          read(
            `(()=>{const e=document.querySelector('.integration-card input[type=checkbox]');if(!e||e.disabled)return false;e.click();return true})()`,
          ),
        'Integration checkbox unavailable',
      );
    const input = async (selector: string, value: string) => {
      await read(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input missing');e.focus();e.select();return true})()`,
      );
      if (selector === '.mcp-form input[type=number]')
        await read(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
        );
      else await cdp.request('Input.insertText', { text: value }, workbench.sessionId);
      await until(
        () => read(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`),
        'Native composer input did not update',
        3000,
      ).catch(async error => {
        throw new Error(
          error.message +
            ': ' +
            JSON.stringify(
              await read(
                `({value:document.querySelector('textarea')?.value,focused:document.hasFocus(),active:document.activeElement?.tagName})`,
              ),
            ),
        );
      });
    };
    const nativeInput = async (value: string, prompt = '') => {
      await until(
        () =>
          cdp.evaluate(
            workbench,
            `(()=>{const widget=document.querySelector('.quick-input-widget'),e=widget?.querySelector('input');if(e&&e.getBoundingClientRect().width&&(widget.textContent.includes(${JSON.stringify(prompt)})||e.placeholder.includes(${JSON.stringify(prompt)}))){e.focus();e.select();return true}return false})()`,
          ),
        'Native input did not open: ' + prompt,
      );
      await cdp.request('Input.insertText', { text: value }, workbench.sessionId);
      await cdp.request(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        workbench.sessionId,
      );
      await cdp.request(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        workbench.sessionId,
      );
    };
    if (process.env.CODEX_UI_SIDEBAR === '1') {
      await until(
        () =>
          read(
            `!document.querySelector('.banner.error') && !document.querySelector('textarea')?.disabled && document.querySelector('.cli-sign-in')?.textContent.includes('CLI sign-in')`,
          ),
        'Initial CLI fixture connection failed',
      );
      const firstOpenMs = Math.round(performance.now() - firstOpenStarted);
      await input('textarea', 'Keep editor draft');
      await vscode.commands.executeCommand('independentCodex.managerView.focus');
      const surface = (name: string) =>
        until(async () => {
          for (const candidate of await targets()) {
            try {
              if (
                await cdp.evaluate(
                  candidate,
                  `document.body?.dataset.surface===${JSON.stringify(name)} && Boolean(document.querySelector('#root main'))`,
                )
              )
                return candidate;
            } catch {}
          }
        }, 'Missing native surface: ' + name);
      const manager = await surface('sidebar');
      const left = (expression: string) => cdp.evaluate(manager, expression);
      await until(
        () => left(`document.querySelector('.usage-panel')?.textContent.includes('80% remaining')`),
        'Manager usage missing',
      );
      assert.equal(await left(`Boolean(document.querySelector('textarea'))`), false);
      // Use the actual Activity Bar icon after closing the primary sidebar.
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await until(
        () =>
          cdp.evaluate(
            workbench,
            `(()=>{const b=document.querySelector('.activitybar .action-label[aria-label^="Codex for VS Code"],.activitybar .action-label[aria-label^="Sessions & Usage"]');if(!b)return false;b.click();return true})()`,
          ),
        'Activity Bar logo missing',
      ).catch(async error => {
        throw new Error(
          error.message +
            ': ' +
            (await cdp.evaluate(
              workbench,
              `JSON.stringify([...document.querySelectorAll('.activitybar [aria-label], [aria-label*=Sessions]')].map(e=>({label:e.getAttribute('aria-label'),parent:e.parentElement.className})))`,
            )),
        );
      });
      await until(() => left(`document.visibilityState==='visible'`), 'Logo did not show manager');
      await until(
        () =>
          left(
            `(()=>{const b=document.querySelector('.manager-new');if(!b||b.disabled)return false;b.click();return true})()`,
          ),
        'New chat disabled',
      );
      const main = await surface('chat');
      const right = (expression: string) => cdp.evaluate(main, expression);
      await until(
        () =>
          right(
            `document.querySelector('textarea')?.value==='' && !document.querySelector('textarea')?.disabled && document.querySelector('.cli-sign-in')?.textContent.includes('CLI sign-in')`,
          ),
        'New chat did not open on right',
      );
      assert.equal(await read(`document.querySelector('textarea')?.value`), 'Keep editor draft');
      // Electron's secondary webview does not consistently route CDP text insertion.
      // Dispatch DOM input through React's public event path; keep native typing coverage in the editor above.
      const rightInput = async (selector: string, value: string) => {
        await right(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
        );
        await until(
          () => right(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`),
          'Right input missing',
        );
      };
      await rightInput('textarea', 'Keep right draft');
      await until(() => left(`document.querySelectorAll('.session').length===2`), 'Manager did not update tabs');
      const switchStarted = performance.now();
      await left(`document.querySelectorAll('.session')[0].click();true`);
      await until(
        () => right(`document.querySelector('textarea')?.value==='Keep editor draft'`),
        'Manager did not select first chat',
      );
      const warmSwitchMs = Math.round(performance.now() - switchStarted);
      await right(`document.querySelector('[aria-label="History"]').click();true`);
      await until(() => right(`Boolean(document.querySelector('.history'))`), 'History did not open');
      await left(`document.querySelectorAll('.session')[0].click();true`);
      await until(
        () =>
          right(
            `!document.querySelector('.history') && document.querySelector('textarea')?.value==='Keep editor draft'`,
          ),
        'Same chat selection did not exit history',
      );
      // Changes to the right history search must not trigger a left-side reset.
      await right(`document.querySelector('[aria-label="History"]').click();true`);
      await until(() => right(`Boolean(document.querySelector('.history-search input'))`), 'Search missing');
      await rightInput('.history-search input', 'right-query');
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal(await left(`document.querySelector('.history-search input')?.value`), '');
      await left(`document.querySelectorAll('.session')[1].click();true`);
      await until(
        () => right(`document.querySelector('textarea')?.value==='Keep right draft'`),
        'Second draft not preserved',
      );
      assert.equal(await read(`document.querySelector('textarea')?.value`), 'Keep editor draft');
      await left(`document.querySelector('.manager').style.width='280px';true`);
      assert.equal(await left(`document.querySelector('.manager').scrollWidth<=280`), true, 'Manager overflows 280px');
      await left(`document.querySelector('.manager').style.width='';true`);
      await vscode.workspace
        .getConfiguration('independentCodex')
        .update('locale', 'zh-CN', vscode.ConfigurationTarget.Global);
      await until(
        () => left(`document.querySelector('summary')?.textContent==='账号与用量'`),
        'Chinese manager missing',
      );
      await vscode.workspace
        .getConfiguration('independentCodex')
        .update('locale', 'en', vscode.ConfigurationTarget.Global);
      for (const check of [read, left, right])
        assert.equal(
          await check(`document.querySelector('.banner.error')?.textContent ?? ''`),
          '',
          'No navigation errors should remain',
        );
      await vscode.commands.executeCommand('notifications.clearAll');
      if (process.env.CODEX_UI_SCREENSHOT) {
        for (const [theme, suffix] of [
          ['Default Light Modern', 'light'],
          ['Default Dark Modern', 'dark'],
        ]) {
          await vscode.workspace
            .getConfiguration('workbench')
            .update('colorTheme', theme, vscode.ConfigurationTarget.Global);
          await until(() => left(`document.body.classList.contains('vscode-${suffix}')`), 'Theme not applied');
          const capture = await cdp.request('Page.captureScreenshot', { format: 'png' }, workbench.sessionId);
          await writeFile(
            process.env.CODEX_UI_SCREENSHOT.replace(/\.png$/, `-${suffix}.png`),
            Buffer.from(capture.data, 'base64'),
          );
        }
      }
      console.log(
        'UI performance (includes test discovery/CDP/poll overhead): ' + JSON.stringify({ firstOpenMs, warmSwitchMs }),
      );
      await writeFile(join(root, 'performance-ui.json'), JSON.stringify({ firstOpenMs, warmSwitchMs }));
      return { sidebar: true, drafts: true, independentEditor: true, navigation: true, locale: true, narrow: true };
    }
    if (process.env.CODEX_EDITOR_RESTORE === '1') {
      await until(
        () =>
          read(
            `document.querySelectorAll('[role=tab]').length===2 && document.querySelector('textarea')?.value==='unsent native alpha'`,
          ),
        'Restored alpha draft or tabs missing',
      );
      assert.equal(
        await read(`document.querySelectorAll('.tab-status.offline').length`),
        2,
        'Reload must not reconnect or replay a task',
      );
      await read(`document.querySelectorAll('[role=tab]')[1].click()`);
      await until(
        () => read(`document.querySelector('textarea')?.value==='unsent native beta'`),
        'Restored beta draft missing',
      );
      await click('History');
      await until(
        () => read(`document.querySelector('.session-groups')?.textContent.includes('Native acceptance')`),
        'Session group was lost after editor restart',
      );
      return { restart: true, noReplay: true };
    }
    await until(
      () => read(`Boolean(document.querySelector('.cli-sign-in')) && !document.querySelector('textarea')?.disabled`),
      'Automatic runtime connection did not settle',
    );
    if (process.env.CODEX_UI_REUSE === '1') {
      await until(
        () => read(`document.querySelector('.cli-sign-in')?.textContent.includes('Using this machine')`),
        'Existing CLI ChatGPT authorization was not reused',
      );
      await until(
        () =>
          read(
            `(()=>{const error=document.querySelector('[role=alert]');if(error)throw Error(error.textContent);return [...document.querySelectorAll('.welcome > button')].some(e=>e.textContent==='New chat'&&!e.disabled)})()`,
          ),
        'CLI reuse connection did not become ready',
        45000,
      ).catch(async error => {
        throw new Error(
          error.message +
            ': ' +
            JSON.stringify(
              await read(
                `({connection:document.querySelector('.connection')?.textContent,welcome:document.querySelector('.welcome')?.textContent,buttons:[...document.querySelectorAll('.welcome > button')].map(e=>({text:e.textContent,disabled:e.disabled})),error:document.querySelector('[role=alert]')?.textContent})`,
              ),
            ),
        );
      });
      assert.equal(
        await read(`Boolean([...document.querySelectorAll('button')].find(e=>e.textContent==='Sign in with ChatGPT'))`),
        false,
      );
      assert.equal(await read(`Boolean(document.querySelector('.auth-state'))`), false);
      if (
        await read(`document.querySelector('[aria-label="Model"] option:checked')?.textContent.includes('Unavailable')`)
      )
        assert.ok(
          await read(
            `document.querySelector('.model-unavailable')?.textContent.includes('Choose a supported combination')`,
          ),
        );
      assert.equal(
        await read(`Boolean(document.querySelector('.conversation-title'))`),
        false,
        'Reuse acceptance must not start a conversation',
      );
      if (process.env.CODEX_UI_SCREENSHOT) {
        const capture = await cdp.request('Page.captureScreenshot', { format: 'png' }, workbench.sessionId);
        await writeFile(process.env.CODEX_UI_SCREENSHOT, Buffer.from(capture.data, 'base64'));
      }
      return { cliReuse: true, noLoginPrompt: true, connectionOnly: true };
    }
    if (process.env.CODEX_UI_MCP === '1') {
      const progress = (stage: string) => writeFile(join(root, 'e2e-progress.json'), JSON.stringify({ stage }));
      await progress('connect');
      await until(
        () =>
          read(
            `document.querySelector('.cli-sign-in')?.textContent.includes('Using this machine')&&!document.querySelector('[aria-label="New chat tab"]')?.disabled`,
          ),
        'Synthetic native connection did not settle',
      );
      await click('MCP');
      await until(
        () => read(`document.querySelector('.integration-card input[type=checkbox]')?.disabled===false`),
        'Synthetic MCP configuration missing',
      );
      await progress('grant');
      await clickCheckbox();
      const consent = `([...document.querySelectorAll('button,[role=button]')].find(e=>e.textContent.includes('Allow this server')&&e.getBoundingClientRect().width))`;
      await until(() => cdp.evaluate(workbench, `Boolean(${consent})`), 'Synthetic MCP consent missing').catch(
        async error => {
          throw new Error(
            error.message +
              ': ' +
              JSON.stringify({
                host: await read(`document.querySelector('[role=alert]')?.textContent`),
                modal: await cdp.evaluate(workbench, `document.querySelector('.monaco-dialog-box')?.textContent`),
              }),
          );
        },
      );
      await cdp.evaluate(workbench, `${consent}.click()`);
      await progress('reconnect');
      await until(
        () =>
          read(
            `document.querySelector('.integration-card input[type=checkbox]')?.checked&&!document.querySelector('.integration-card input[type=checkbox]').disabled`,
          ),
        'MCP grant did not reconnect',
      );
      await click('Chat');
      await click('New chat');
      await until(
        () => read(`Boolean(document.querySelector('textarea'))&&!document.querySelector('textarea').disabled`),
        'Native synthetic composer did not become ready',
      );
      await input('textarea', 'Run the synthetic collect tool.');
      await click('Send');
      await progress('form');
      await until(
        () => read(`Boolean(document.querySelector('.mcp-form'))`),
        'Actual native MCP form did not reach the editor',
        30000,
      ).catch(async error => {
        throw new Error(error.message + ': ' + (await read(`document.querySelector('main')?.textContent`)));
      });
      assert.equal(await read(`document.querySelector('.mcp-form button[type=submit]')?.disabled`), true);
      await read(`document.querySelector('.app').style.width='320px'; true`);
      assert.equal(
        await read(`document.querySelector('.app').scrollWidth<=document.querySelector('.app').clientWidth+1`),
        true,
        'Native MCP form overflows a narrow pane',
      );
      await read(`document.querySelector('.app').style.width=''; true`);
      await input('.mcp-form input[type=text]', 'SYNTHETIC_FORM');
      await input('.mcp-form input[type=number]', '0');
      await read(
        `(()=>{const e=document.querySelector('.mcp-form select');e.value='false';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
      );
      await until(
        () => read(`document.querySelector('.mcp-form button[type=submit]')?.disabled===false`),
        'Native form did not preserve false/zero answers',
      );
      if (process.env.CODEX_UI_SCREENSHOT) {
        await read(`document.querySelector('.mcp-form').scrollIntoView({block:'start'}); true`);
        const capture = await cdp.request('Page.captureScreenshot', { format: 'png' }, workbench.sessionId);
        await writeFile(process.env.CODEX_UI_SCREENSHOT, Buffer.from(capture.data, 'base64'));
      }
      await click('Submit answers');
      await until(
        () =>
          read(
            `!document.querySelector('.mcp-form')&&[...document.querySelectorAll('.agentMessage')].some(e=>e.textContent.includes('SYNTHETIC_FORM_ACCEPT'))`,
          ),
        'Editor/host/native MCP acceptance did not complete',
        30000,
      );
      await click('Usage');
      await until(
        () =>
          read(
            `document.querySelector('.usage-panel')?.textContent.includes('80% remaining')&&document.querySelector('.token-usage')?.textContent.includes('20')`,
          ),
        'Native usage did not reach the panel',
      );
      await read(`document.querySelector('.app').style.width='320px'; true`);
      assert.equal(
        await read(`document.querySelector('.app').scrollWidth<=document.querySelector('.app').clientWidth+1`),
        true,
        'Native usage overflows a narrow pane',
      );
      await read(`document.querySelector('.app').style.width=''; true`);
      await click('Chat');
      await click('History');
      const clipboard = await vscode.env.clipboard.readText();
      try {
        await click('Copy chat as Markdown');
        await until(
          async () => (await vscode.env.clipboard.readText()).includes('SYNTHETIC_FORM_ACCEPT'),
          'Native full-history export did not reach clipboard',
        );
      } finally {
        await vscode.env.clipboard.writeText(clipboard);
      }
      await click('Export chat to document');
      await until(
        async () =>
          vscode.window.activeTextEditor?.document.isUntitled &&
          vscode.window.activeTextEditor.document.languageId === 'markdown' &&
          vscode.window.activeTextEditor.document.getText().includes('SYNTHETIC_FORM_ACCEPT'),
        'Native export did not open an unsaved Markdown document',
      );
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      return {
        nativeMcpForm: true,
        nativeExport: true,
        nativeTokenUsage: true,
        nativeConsent: true,
        syntheticProvider: true,
        liveEntitlement: false,
      };
    }
    const live = process.env.CODEX_UI_LIVE === '1';
    if (!live) {
      await until(
        () =>
          read(
            `document.querySelector('.cli-sign-in')?.textContent.includes('No ChatGPT sign-in')&&!document.querySelector('.cli-sign-in button')?.disabled`,
          ),
        'Signed-out CLI guidance did not wait for native account readback',
      );
      await click('Check CLI sign-in again');
      await until(
        () =>
          read(
            `document.querySelector('.cli-sign-in')?.textContent.includes('No ChatGPT sign-in')&&!document.querySelector('.cli-sign-in button')?.disabled`,
          ),
        'Explicit native CLI recheck did not settle',
      );
    }
    const chooseLiveModel = async (effort = 'low') => {
      const preferred = 'gpt-5.6-sol';
      await click('Model');
      await click('Select model');
      const option = `[...document.querySelectorAll('.model-option')].find(e=>e.querySelector('span')?.textContent.toLowerCase().replace(/\\s+/g,'-')===${JSON.stringify(preferred)})`;
      assert.ok(await read(`Boolean(${option})`), 'Previously accepted live model is absent from the actual catalog');
      await read(`${option}.click()`);
      await until(
        () =>
          read(
            `document.querySelector('.model-picker > button')?.textContent.toLowerCase().includes('gpt-5.6')&&!document.querySelector('.model-picker > button').disabled`,
          ),
        'Explicit live model not selected',
      );
      if (!(await read(`Boolean(document.querySelector('input[aria-label="Reasoning"]'))`))) await click('Model');
      const effortName = effort[0].toUpperCase() + effort.slice(1);
      let found = false;
      const maximum = Number(await read(`document.querySelector('input[aria-label="Reasoning"]').max`));
      for (let index = 0; index <= maximum; index++) {
        await read(
          `(()=>{const e=document.querySelector('input[aria-label="Reasoning"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(index))});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
        );
        await read(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
        if (
          await read(
            `document.querySelector('input[aria-label="Reasoning"]')?.getAttribute('aria-valuetext')===${JSON.stringify(effortName)}`,
          )
        ) {
          await read(
            `document.querySelector('input[aria-label="Reasoning"]').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`,
          );
          found = true;
          break;
        }
      }
      assert.ok(found, 'Actual reasoning effort unavailable');
      await until(
        () =>
          read(
            `document.querySelector('.model-picker > button')?.textContent.includes(${JSON.stringify(effortName)})&&!document.querySelector('.model-picker > button').disabled`,
          ),
        'Reasoning preference did not cross the native bridge',
      );
      await read(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
      await click('Permissions and runtime');
      await read(
        `(()=>{const e=document.querySelector('.native-controls select');e.value=':workspace';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
      );
      await until(
        () =>
          read(
            `document.querySelector('.native-controls summary')?.textContent.includes(':workspace')&&!document.querySelector('.native-controls select')?.disabled`,
          ),
        'Test workspace profile was not selected explicitly',
      );
      await click('Chat');
    };
    if (process.env.CODEX_UI_NATIVE_REVIEW === '1') {
      // Real account, real production webview/host: pre-apply diff review, title-bar accept, undo and rewind.
      const dialog = async (label: string) => {
        const button = `([...document.querySelectorAll('.monaco-dialog-box button,.monaco-dialog-box [role=button]')].find(e=>e.textContent.trim()===${JSON.stringify(label)}))`;
        await until(() => cdp.evaluate(workbench, `Boolean(${button})`), 'Dialog button missing: ' + label);
        await cdp.evaluate(workbench, `${button}.click()`);
      };
      const hostError = () => read(`document.querySelector('[role=alert]')?.textContent||''`);
      const diffTabs = () =>
        vscode.window.tabGroups.all
          .flatMap(g => g.tabs)
          .filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'codex-proposed');
      const turn = async (file: string) => {
        await input(
          'textarea',
          `Create a new file named ${file} in the workspace root containing exactly one line: hello from codex. Use apply_patch only. Do not run shell commands, do not read files, then reply with the single word DONE.`,
        );
        await click('Send');
        await until(
          () =>
            read(
              `document.querySelector('.decision.approval .change-list')?.textContent.includes(${JSON.stringify(file)})`,
            ),
          'No file-change approval card for ' + file,
          240000,
        ).catch(async error => {
          throw new Error(
            error.message +
              ': ' +
              JSON.stringify({
                error: await hostError(),
                cards: await read(`[...document.querySelectorAll('.decision')].map(e=>e.textContent).join(' | ')`),
              }),
          );
        });
        await until(async () => diffTabs().length > 0, 'Native diff editor did not open for ' + file, 10000);
        await assert.rejects(readFile(join(root, file)), { code: 'ENOENT' }, 'File written before acceptance');
        // Accept through the editor-title command bound to the proposed diff, not the chat card.
        const tab = diffTabs()[0];
        await vscode.window.showTextDocument((tab.input as vscode.TabInputTextDiff).modified, { preview: true });
        await vscode.commands.executeCommand('independentCodex.acceptProposedDiff');
        await until(
          async () => (await readFile(join(root, file), 'utf8').catch(() => '')).includes('hello from codex'),
          'Accepted file was not written: ' + file,
          120000,
        );
        await until(async () => diffTabs().length === 0, 'Diff tab was not closed after acceptance', 10000);
        // Hidden chats intentionally defer rendering; return from the file editor before checking the view.
        const chatTab = await cdp.evaluate(
          workbench,
          `(()=>{const e=[...document.querySelectorAll('.tabs-container .tab')].find(e=>e.textContent==='Codex for VS Code');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        for (const type of ['mousePressed', 'mouseReleased'])
          await cdp.request(
            'Input.dispatchMouseEvent',
            { type, ...chatTab, button: 'left', clickCount: 1 },
            workbench.sessionId,
          );
        await until(
          () =>
            read(`!document.querySelector('[aria-label="Stop"]')&&Boolean(document.querySelector('.turn-changes'))`),
          'Turn did not finish with a changed-files card',
          240000,
        ).catch(async error => {
          throw new Error(
            error.message +
              ': ' +
              JSON.stringify({
                error: await hostError(),
                stop: await read(`Boolean(document.querySelector('[aria-label="Stop"]'))`),
                changes: await read(`document.querySelectorAll('.turn-changes').length`),
                main: await read(`document.querySelector('main')?.textContent?.slice(-6000)`),
              }),
          );
        });
      };
      await until(
        () =>
          read(
            `Boolean(document.querySelector('[aria-label="New chat"]'))&&!document.querySelector('[aria-label="New chat"]').disabled&&!document.querySelector('.welcome > button')`,
          ),
        'Live sign-in unavailable',
        60000,
      );
      await click('New chat');
      await until(
        () =>
          read(
            `Boolean(document.querySelector('textarea'))&&!document.querySelector('textarea').disabled&&!document.querySelector('[aria-label="Model"]')?.disabled`,
          ),
        'Native draft did not become ready',
        60000,
      );
      await chooseLiveModel('low');
      assert.equal(
        await read(`document.querySelector('.approval-picker > button')?.textContent.trim()`),
        'Review every edit',
        'New chats must ask before edits',
      );
      await turn('live-undo.txt');
      await read(
        `[...document.querySelectorAll('.turn-changes button')].find(e=>e.textContent.trim()==='Undo').click()`,
      );
      await dialog('Undo changes');
      await until(
        async () =>
          !(await readFile(join(root, 'live-undo.txt')).then(
            () => true,
            () => false,
          )),
        'Undo did not remove the created file: ' + (await hostError()),
        15000,
      );
      await turn('live-rewind.txt');
      const messages = await read(`document.querySelectorAll('.message.userMessage').length`);
      assert.equal(messages, 2);
      await read(`[...document.querySelectorAll('.message.userMessage')][1].querySelector('.rewind').click()`);
      await dialog('Rewind');
      await until(
        async () =>
          !(await readFile(join(root, 'live-rewind.txt')).then(
            () => true,
            () => false,
          )) && (await read(`document.querySelectorAll('.message.userMessage').length`)) === 1,
        'Rewind did not restore files and history',
        30000,
      ).catch(async error => {
        throw new Error(error.message + ': ' + (await hostError()));
      });
      await click('History');
      await click('Archive current chat');
      await dialog('Archive chat');
      return { nativeReview: true, diffTab: true, titleAccept: true, undo: true, rewind: true, archived: true };
    }
    if (live) {
      await until(
        () =>
          read(
            `!document.querySelector('[aria-label="New chat"]')?.disabled&&!document.querySelector('.welcome > button')&&!document.querySelector('[aria-label="New chat tab"]')?.disabled`,
          ),
        'Live sign-in unavailable',
      );
      await click('New chat');
      await until(
        () =>
          read(
            `Boolean(document.querySelector('.conversation-title'))&&!document.querySelector('[aria-label="New chat tab"]')?.disabled`,
          ),
        'Initial owned chat did not start',
      ).catch(async error => {
        throw new Error(
          error.message + ': ' + (await read(`document.querySelector('[role=alert]')?.textContent||'No host error'`)),
        );
      });
      await chooseLiveModel('max');
    }
    await until(
      () => read(`!document.querySelector('[aria-label="New chat tab"]')?.disabled`),
      'Connection did not settle',
    );
    await input('textarea', 'unsent native alpha');
    await click('New chat tab');
    await until(
      () =>
        read(
          `document.querySelectorAll('[role=tab]').length===2 && document.querySelectorAll('[role=tab]')[1].getAttribute('aria-selected')==='true' && document.querySelector('textarea')?.value===''`,
        ),
      'Independent tab not selected',
    );
    if (live) {
      await until(
        () =>
          read(
            `Boolean(document.querySelector('.conversation-title'))&&!document.querySelector('[aria-label="New chat tab"]')?.disabled`,
          ),
        'Second owned chat did not finish loading',
        30000,
      );
      await chooseLiveModel();
    }
    await input('textarea', 'unsent native beta');
    await read(`document.querySelectorAll('[role=tab]')[0].click()`);
    await until(
      () => read(`document.querySelector('textarea')?.value==='unsent native alpha'`),
      'Alpha draft leaked or was lost',
    );
    await click('New group');
    await nativeInput('Native acceptance');
    await click('Chat');
    if (await read(`document.querySelector('[aria-label="History"]')?.getAttribute('aria-expanded')==='false'`))
      await click('History');
    await until(
      () =>
        read(
          `Boolean([...document.querySelectorAll('.session-group')].find(e=>e.textContent.includes('Native acceptance')))`,
        ),
      'Group creation did not cross the real bridge',
    );
    await read(
      `(()=>{const e=document.querySelector('.group-assignment select');e.value=e.options[1].value;e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
    );
    await until(() => read(`Boolean(document.querySelector('.group-members .session'))`), 'Group assignment failed');
    if (!live) {
      await click('Ecosystem');
      await until(
        () =>
          read(
            `document.querySelector('.integrations')?.textContent.includes('Hooks')&&Boolean(document.querySelector('.integrations input[type=checkbox]'))`,
          ),
        'Native ecosystem inventory missing',
      );
      await click('Chat');
      await click('Permissions and runtime');
      await until(
        () => read(`Boolean(document.querySelector('.native-controls select option[value=":read-only"]'))`),
        'Native permission profile catalog missing',
      );
      await read(
        `(()=>{const e=document.querySelector('.native-controls select');e.value=':workspace';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
      );
      await until(
        () =>
          read(
            `document.querySelector('.native-controls summary')?.textContent.includes(':workspace')&&!document.querySelector('.native-controls select')?.disabled`,
          ),
        'Native permission selection did not cross the bridge',
      );
      await read(
        `(()=>{const e=document.querySelector('.native-controls select');e.value=':read-only';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
      );
      await until(
        () => read(`document.querySelector('.native-controls summary')?.textContent.includes(':read-only')`),
        'Native permission preference did not persist through the bridge',
      );
    }
    await click('Skills');
    await until(
      () => read(`document.querySelector('.integration-list')?.textContent.includes('native-fixture')`),
      'Actual skills/list did not populate the webview',
    );
    if (live) {
      const token = async (name: string) =>
        /(?:ALPHA|BETA)_[a-f0-9]{24}/.exec(
          await readFile(join(root, '.agents', 'skills', name, 'SKILL.md'), 'utf8'),
        )![0];
      const alpha = await token('native-fixture'),
        beta = await token('native-second');
      const selectSkill = async (name: string) => {
        await click('Skills');
        const card = `([...document.querySelectorAll('.integration-card')].find(e=>e.querySelector('h3')?.textContent===${JSON.stringify(name)}))`;
        await until(
          () =>
            read(
              `(()=>{const card=${card};const button=card&&[...card.querySelectorAll('button')].find(e=>e.textContent==='Use in chat');if(!button||button.disabled)return false;button.click();return true})()`,
            ),
          'Fixture skill unavailable',
        );
        await until(
          () => read(`document.querySelector('.skill-contexts')?.textContent.includes(${JSON.stringify(name)})`),
          'Explicit fixture skill was not acknowledged',
        ).catch(async error => {
          throw new Error(
            error.message +
              ': ' +
              JSON.stringify(
                await read(
                  `({error:document.querySelector('[role=alert]')?.textContent,skills:document.querySelector('.skill-contexts')?.textContent,panel:document.querySelector('.integration-panel')?.getAttribute('aria-label'),tabs:[...document.querySelectorAll('[role=tab]')].map(e=>e.getAttribute('aria-selected'))})`,
                ),
              ),
          );
        });
      };
      await selectSkill('native-fixture');
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
      await input(
        'textarea',
        'Native UI acceptance: follow the selected skill acceptance procedure. Use the native apply_patch tool to create native-agent.txt in this workspace containing only the acceptance token and a newline. Then return only that exact token. Do not read other project files or use unrelated skills.',
      );
      await click('Send');
      await until(
        () => read(`Boolean(document.querySelector('.tab-status.starting,.tab-status.running,.tab-status.waiting'))`),
        'First real model turn did not start',
      );
      await read(`document.querySelectorAll('[role=tab]')[1].click()`);
      await until(
        () =>
          read(
            `document.querySelectorAll('[role=tab]')[1]?.getAttribute('aria-selected')==='true'&&!document.querySelector('[aria-label="New chat tab"]')?.disabled`,
          ),
        'Second chat did not become ready',
        30000,
      ).catch(async error => {
        throw new Error(
          error.message +
            ': ' +
            JSON.stringify(
              await read(
                `({status:document.querySelector('.connection')?.textContent,error:document.querySelector('[role=alert]')?.textContent,tabs:[...document.querySelectorAll('[role=tab]')].map(e=>e.getAttribute('aria-selected'))})`,
              ),
            ),
        );
      });
      await selectSkill('native-second');
      await input(
        'textarea',
        'Native UI acceptance: return only the exact acceptance token from the explicitly selected skill. Do not read other project files or use unrelated skills.',
      );
      await click('Send');
      await until(
        () =>
          read(
            `(()=>{const error=document.querySelector('[role=alert]');if(error)throw Error(error.textContent);return [...document.querySelectorAll('.agentMessage')].some(e=>e.textContent.includes(${JSON.stringify(beta)}))})()`,
          ),
        'Second selected Skill did not reach the real model',
        120000,
      );
      assert.equal(
        await read(
          `[...document.querySelectorAll('.agentMessage')].some(e=>e.textContent.includes(${JSON.stringify(alpha)}))`,
        ),
        false,
      );
      await until(
        () => read(`!document.querySelector('.tab-status.starting,.tab-status.running,.tab-status.waiting')`),
        'Model turns did not finish',
        120000,
      );
      assert.ok(
        await read(`Boolean(document.querySelector('.session-tab:first-child .unread'))`),
        'Hidden sidebar must not consume background unread state',
      );
      await read(`document.querySelectorAll('[role=tab]')[0].click()`);
      await until(
        () =>
          read(
            `[...document.querySelectorAll('.agentMessage')].some(e=>e.textContent.includes(${JSON.stringify(alpha)}))`,
          ),
        'First selected Skill output was lost',
        120000,
      );
      assert.equal(
        await read(
          `[...document.querySelectorAll('.agentMessage')].some(e=>e.textContent.includes(${JSON.stringify(beta)}))`,
        ),
        false,
      );
      assert.equal(
        (await readFile(join(root, 'native-agent.txt'), 'utf8')).trim(),
        alpha,
        'The Max native Agent must perform the real disposable file edit',
      );
      assert.equal(await read(`document.querySelector('[aria-label="Reasoning"]')?.value`), 'max');
      for (const index of [0, 1]) {
        await read(`document.querySelectorAll('[role=tab]')[${index}].click()`);
        await until(
          () => read(`document.querySelectorAll('[role=tab]')[${index}]?.getAttribute('aria-selected')==='true'`),
          'Cleanup chat not selected',
        );
        if (await read(`document.querySelector('[aria-label="History"]')?.getAttribute('aria-expanded')==='false'`))
          await click('History');
        await click('Archive current chat');
        const button = `([...document.querySelectorAll('button,[role=button]')].find(e=>e.textContent.includes('Archive chat')&&e.getBoundingClientRect().width))`;
        await until(() => cdp.evaluate(workbench, `Boolean(${button})`), 'Native archive confirmation missing');
        await cdp.evaluate(workbench, `${button}.click()`);
        await until(
          () =>
            read(
              `!document.querySelector('.conversation-title')&&!document.querySelector('[aria-label="New chat tab"]')?.disabled`,
            ),
          'Synthetic acceptance chat did not archive',
        );
      }
      return {
        tabs: true,
        drafts: true,
        groups: true,
        skills: true,
        live: true,
        max: true,
        nativeEdit: true,
        isolatedReplies: true,
        backgroundUnread: true,
        archivedFixtures: true,
      };
    }
    await until(
      () => read(`document.querySelector('.integration-card input[type=checkbox]')?.disabled===false`),
      'Skills inventory did not settle',
    );
    await clickCheckbox();
    await until(
      () =>
        read(
          `document.querySelector('.integration-card input[type=checkbox]')?.checked===false && !document.querySelector('.integration-card input[type=checkbox]').disabled`,
        ),
      'Skill disable/readback failed',
    );
    await clickCheckbox();
    await until(
      () =>
        read(
          `document.querySelector('.integration-card input[type=checkbox]')?.checked===true && !document.querySelector('.integration-card input[type=checkbox]').disabled`,
        ),
      'Skill enable/readback failed',
    );
    await click('Use in chat');
    await until(
      () => read(`document.querySelector('.skill-contexts')?.textContent.includes('native-fixture')`),
      'Selected skill chip missing',
    );
    await click('MCP');
    await until(
      () => read(`document.querySelector('.integration-list')?.textContent.includes('native_mcp')`),
      'MCP config inventory did not populate',
    );
    await click('Remove');
    const confirmation = `([...document.querySelectorAll('button,[role=button]')].find(e=>e.textContent.includes('Remove configuration')&&e.getBoundingClientRect().width))`;
    await until(() => cdp.evaluate(workbench, `Boolean(${confirmation})`), 'Native remove confirmation missing').catch(
      async error => {
        throw new Error(
          error.message + ': ' + (await read(`document.querySelector('[role=alert]')?.textContent||'No host error'`)),
        );
      },
    );
    await cdp.evaluate(workbench, `${confirmation}.click()`);
    await until(
      () => read(`document.querySelector('.integration-panel')?.textContent.includes('No MCP servers configured')`),
      'MCP removal did not read back after reconnect',
      25000,
    );
    assert.ok(!(await readFile(join(process.env.CODEX_HOME!, 'config.toml'), 'utf8')).includes('native_mcp'));
    await click('Add server');
    await nativeInput('native_added', 'MCP server name');
    await nativeInput('stdio', 'Choose an MCP transport');
    await nativeInput('node', 'Executable (no shell)');
    await nativeInput('[]', 'Arguments (JSON string array)');
    await until(
      () =>
        read(
          `document.querySelector('.integration-list')?.textContent.includes('native_added')&&!document.querySelector('.integration-card input[type=checkbox]')?.disabled`,
        ),
      'Native MCP add did not read back',
      25000,
    );
    assert.equal(
      await read(`document.querySelector('.integration-card input[type=checkbox]')?.checked`),
      false,
      'New native MCP config must be disabled',
    );
    await click('Remove');
    await until(() => cdp.evaluate(workbench, `Boolean(${confirmation})`), 'Second native remove confirmation missing');
    await cdp.evaluate(workbench, `${confirmation}.click()`);
    await until(
      () => read(`document.querySelector('.integration-panel')?.textContent.includes('No MCP servers configured')`),
      'Added MCP was not removed',
      25000,
    );
    await click('Usage');
    await until(
      () => read(`document.querySelector('.usage-panel')?.textContent.includes('Unavailable')`),
      'Signed-out native usage must remain unavailable',
    );
    assert.equal(
      await read(`document.querySelector('.usage-panel button')?.disabled`),
      true,
      'Signed-out account must not make usage requests',
    );
    await click('Chat');
    await input('textarea', '$native');
    await until(
      () => read(`document.querySelector('[role=listbox]')?.textContent.includes('native-fixture')`),
      'Skill composer autocomplete missing',
    );
    await read(`document.querySelector('[role=option]').click()`);
    await until(
      () => read(`document.querySelector('textarea')?.value===''`),
      'Skill selection did not acknowledge and remove its trigger',
    );
    await input('textarea', '/mcp');
    await until(() => read(`Boolean(document.querySelector('[role=option]'))`), 'Slash command picker missing');
    await read(`document.querySelector('[role=option]').click()`);
    await until(
      () => read(`Boolean(document.querySelector('.integration-panel'))`),
      'Slash MCP command did not navigate',
    );
    await click('Memories');
    await until(
      () => read(`document.querySelector('.local-data')?.textContent.includes('memories/MEMORY.md')`),
      'Native memory metadata missing',
    );
    assert.equal(await read(`document.querySelector('.local-preview')===null`), true);
    await click('memories/MEMORY.md');
    await until(
      () => read(`document.querySelector('.local-preview')?.textContent.includes('SYNTHETIC_NATIVE_MEMORY_ONLY')`),
      'Native read-only memory preview missing',
    );
    await click('Back to list');
    await until(
      () => read(`Boolean(document.querySelector('.memory-file'))&&!document.querySelector('.local-preview')`),
      'Closing memory preview lost its metadata list',
    );
    await click('memories/MEMORY.md');
    await until(() => read(`Boolean(document.querySelector('.local-preview'))`), 'Memory preview did not reopen');
    await read(`document.querySelector('.app').style.width='320px'; true`);
    assert.equal(
      await read(`document.querySelector('.app').scrollWidth <= document.querySelector('.app').clientWidth+1`),
      true,
      'Memory preview overflows a narrow pane',
    );
    await read(`document.querySelector('.app').style.width=''; true`);
    if (process.env.CODEX_UI_SCREENSHOT) {
      const capture = await cdp.request('Page.captureScreenshot', { format: 'png' }, workbench.sessionId);
      await writeFile(
        process.env.CODEX_UI_SCREENSHOT.replace(/\.png$/, '-memories.png'),
        Buffer.from(capture.data, 'base64'),
      );
    }
    await click('Tasks');
    await until(
      () => read(`document.querySelector('.local-data')?.textContent.includes('No child agents found')`),
      'Native agent task panel missing',
    );
    await click('Memories');
    await until(
      () =>
        read(
          `document.querySelector('.local-data')?.textContent.includes('memories/MEMORY.md')&&!document.querySelector('.local-preview')`,
        ),
      'Memory preview survived leaving its pane',
    );
    await click('Chat');
    await input('textarea', 'unsent native alpha');
    if (process.env.CODEX_UI_SCREENSHOT) {
      await read(`(()=>{const d=document.querySelector('.native-controls');if(d)d.open=true;return true})()`);
      const capture = await cdp.request('Page.captureScreenshot', { format: 'png' }, workbench.sessionId);
      await writeFile(process.env.CODEX_UI_SCREENSHOT, Buffer.from(capture.data, 'base64'));
    }
    await writeFile(
      join(root, 'native-ui-receipt.json'),
      JSON.stringify({
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
        actualBridge: true,
      }),
    );
    return {
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
    };
  } finally {
    cdp.close();
  }
}
