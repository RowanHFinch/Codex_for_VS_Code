import React from 'react';
import type { Action, ViewState } from '../src/shared';
import type en from '../locales/en.json';
import { Icon } from './icons';

type HubPane = 'skills' | 'mcp' | 'agents' | 'memories' | 'usage' | 'ecosystem' | 'settings' | 'terminals';
type Props = {
  state: ViewState;
  t: typeof en;
  post(action: Action): void;
  open(pane: HubPane): void;
  focusView: boolean;
  toggleFocusView(): void;
};
type Row = {
  label: string;
  hint: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  run(): void;
  checked?: boolean;
  hidden?: boolean;
};

/** Everything that is not about the current chat lives here, so the header menu stays short. */
export function Hub({ state, t, post, open, focusView, toggleFocusView }: Props) {
  const online = !['offline', 'connecting', 'unknown'].includes(state.status);
  const sections: [string, Row[]][] = [
    [
      t.hubFeatures,
      [
        { label: t.skills, icon: 'list', hint: t.hubSkillsHint, run: () => open('skills') },
        { label: t.mcp, icon: 'plug', hint: t.hubMcpHint, run: () => open('mcp') },
        { label: t.agentTasks, icon: 'branch', hint: t.hubTasksHint, run: () => open('agents') },
        { label: t.memoryBrowser, icon: 'file', hint: t.hubMemoriesHint, run: () => open('memories') },
        { label: t.usage, icon: 'list', hint: t.hubUsageHint, run: () => open('usage') },
        { label: t.ecosystem, icon: 'plug', hint: t.hubEcosystemHint, run: () => open('ecosystem') },
      ],
    ],
    [
      t.hubWorkspace,
      [
        { label: t.runtimePane, icon: 'shield', hint: t.hubRuntimeHint, run: () => open('settings') },
        { label: t.instructions, icon: 'file', hint: t.hubInstructionsHint, run: () => post({ type: 'instructions' }) },
        {
          label: t.terminalsTitle,
          icon: 'terminal',
          hint: t.hubTerminalsHint,
          run: () => open('terminals'),
          hidden: !state.threadId || !online,
        },
        { label: t.focusView, icon: 'focus', hint: t.hubFocusHint, run: toggleFocusView, checked: focusView },
        { label: t.addGroup, icon: 'plus', hint: t.hubGroupHint, run: () => post({ type: 'addGroup' }) },
      ],
    ],
    [
      t.hubHelp,
      [
        { label: t.logs, icon: 'terminal', hint: t.hubLogsHint, run: () => post({ type: 'logs' }) },
        {
          label: t.diagnosticReport,
          icon: 'file',
          hint: t.hubDiagnosticsHint,
          run: () => post({ type: 'diagnostics' }),
        },
        { label: t.settings, icon: 'list', hint: t.hubVsCodeHint, run: () => post({ type: 'settings' }) },
      ],
    ],
  ];
  return (
    <section className="hub">
      {sections.map(([title, rows]) => (
        <section key={title} aria-label={title}>
          <h2>{title}</h2>
          {rows
            .filter(row => !row.hidden)
            .map(row => (
              <button
                key={row.label}
                className="hub-item"
                aria-label={row.label}
                role={row.checked === undefined ? undefined : 'switch'}
                aria-checked={row.checked}
                onClick={row.run}
              >
                <Icon name={row.icon} />
                <span>{row.label}</span>
                <small>{row.hint}</small>
                {row.checked !== undefined ? (
                  <i className="hub-check">{row.checked ? '✓' : '–'}</i>
                ) : (
                  <Icon name="chevron" />
                )}
              </button>
            ))}
        </section>
      ))}
    </section>
  );
}
