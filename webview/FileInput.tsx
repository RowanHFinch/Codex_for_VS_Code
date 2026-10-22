import React, { useEffect, useRef, useState } from 'react';
import type { Action, FileChoice, FileResult, SkillChoice } from '../src/shared';
import type en from '../locales/en.json';
import { composerTrigger, shouldSend } from './input';
import { Icon } from './icons';

export function FileInput({
  draft,
  threadId,
  disabled,
  sendKey,
  t,
  changeDraft,
  send,
  post,
  onBusy,
  recall,
  skills,
  commands,
  command,
}: {
  draft: string;
  threadId?: string;
  disabled: boolean;
  sendKey: 'enter' | 'modEnter';
  t: typeof en;
  skills: SkillChoice[];
  commands: string[];
  command(name: string): void;
  changeDraft(text: string): void;
  send(): void;
  post(action: Action): void;
  onBusy(busy: boolean): void;
  /** The last message sent in this chat, offered by Up in an empty composer. */
  recall?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null),
    request = useRef(0);
  const [prefix] = useState(() => crypto.randomUUID());
  const [cursor, setCursor] = useState(draft.length),
    [focused, setFocused] = useState(false),
    [dismissed, setDismissed] = useState('');
  const [result, setResult] = useState<{ files: FileChoice[]; loading: boolean; limited?: boolean; failed?: boolean }>({
    files: [],
    loading: false,
  });
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState<{
    id: string;
    draft: string;
    threadId?: string;
    start: number;
    end: number;
  }>();
  const signature = `${draft}\0${cursor}`;
  useEffect(() => {
    setPending(undefined);
    onBusy(false);
    setDismissed('');
    setSelected(0);
  }, [threadId, onBusy]);
  const match =
    focused && !disabled && !pending && signature !== dismissed ? composerTrigger(draft, cursor) : undefined;
  const query = match?.query;
  const trigger = match?.trigger;
  const options: FileChoice[] =
    trigger === '$'
      ? skills
          .filter(skill => skill.enabled && skill.name.toLowerCase().includes((query ?? '').toLowerCase()))
          .map(skill => ({ id: skill.id, path: `$${skill.name}` }))
      : trigger === '/'
        ? commands
            .filter(name => name.includes((query ?? '').toLowerCase()))
            .map(name => ({ id: name, path: `/${name}` }))
        : result.files;
  const heading = trigger === '$' ? t.skills : trigger === '/' ? t.commands : t.mentionFiles;
  useEffect(() => {
    const current = ++request.current;
    setResult({ files: [], loading: query !== undefined && trigger === '@' });
    setSelected(0);
    if (query === undefined || trigger !== '@') return;
    const timer = setTimeout(() => post({ type: 'findFiles', query, requestId: `${prefix}-${current}` }), 120);
    return () => {
      clearTimeout(timer);
    };
  }, [query, trigger, threadId, prefix, post]);
  useEffect(() => {
    // Focusing the chat view (Cmd/Ctrl+Escape from the editor) lands in the composer unless a control already has focus.
    const focus = () => {
      if (document.activeElement === document.body) input.current?.focus();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  useEffect(() => {
    const handler = (event: MessageEvent<FileResult>) => {
      const data = event.data;
      if (data?.type === 'fileResults' && data.requestId === `${prefix}-${request.current}`)
        setResult({ ...data, loading: false });
      if ((data?.type === 'fileAttached' || data?.type === 'skillAttached') && pending?.id === data.id) {
        if (data.ok && pending.threadId === threadId && pending.draft === draft) {
          changeDraft(draft.slice(0, pending.start) + draft.slice(pending.end));
          setCursor(pending.start);
          requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.setSelectionRange(pending.start, pending.start);
          });
        }
        setPending(undefined);
        onBusy(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [prefix, pending, threadId, draft, changeDraft, onBusy]);
  useEffect(() => () => onBusy(false), [onBusy]);
  useEffect(() => {
    document.getElementById(`${prefix}-file-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [prefix, selected, result.files, skills, trigger]);
  const choose = (file: FileChoice) => {
    if (!match || result.loading) return;
    if (trigger === '/') {
      setDismissed(signature);
      changeDraft(draft.slice(0, match.start) + draft.slice(match.end));
      setCursor(match.start);
      command(file.id);
      return;
    }
    setPending({ id: file.id, draft, threadId, start: match.start, end: match.end });
    setDismissed(signature);
    onBusy(true);
    post(
      trigger === '$'
        ? { type: 'selectSkill', id: file.id }
        : { type: 'attachFile', id: file.id, threadId: threadId ?? null },
    );
  };
  return (
    <>
      {match ? (
        <div className="file-picker">
          <div className="file-picker-heading">
            {heading}
            <small>{t.mentionKeys}</small>
          </div>
          <ul id={`${prefix}-files`} role="listbox" aria-label={heading}>
            {options.map((file, index) => (
              <li
                role="option"
                id={`${prefix}-file-${index}`}
                key={file.id}
                aria-selected={index === selected}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(file)}
              >
                <Icon name="file" />
                <span title={file.path}>{file.path}</span>
              </li>
            ))}
          </ul>
          {result.loading || !options.length ? (
            <p role="status">
              {result.loading
                ? t.findingFiles
                : result.failed
                  ? t.fileSearchFailed
                  : trigger === '$'
                    ? t.noSkills
                    : t.noFiles}
            </p>
          ) : null}
          {result.limited ? <p>{t.moreFileMatches}</p> : null}
        </div>
      ) : null}
      <label className="sr-only" htmlFor="composer">
        {t.composer}
      </label>
      <textarea
        ref={input}
        id="composer"
        value={draft}
        placeholder={t.placeholder}
        rows={2}
        spellCheck={false}
        aria-describedby="send-help"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={Boolean(match)}
        aria-controls={match ? `${prefix}-files` : undefined}
        aria-activedescendant={match && options[selected] ? `${prefix}-file-${selected}` : undefined}
        onFocus={e => {
          setFocused(true);
          // Programmatic insertions (the @ button, starters) move the caret before focusing.
          setCursor(e.currentTarget.selectionStart);
        }}
        onBlur={() => setFocused(false)}
        onClick={e => setCursor(e.currentTarget.selectionStart)}
        onSelect={e => setCursor(e.currentTarget.selectionStart)}
        onChange={e => {
          changeDraft(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          if (match) {
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(signature);
              return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected(index =>
                options.length ? (index + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length : 0,
              );
              return;
            }
            if (e.key === 'Enter' || (e.key === 'Tab' && options.length)) {
              e.preventDefault();
              if (options[selected]) choose(options[selected]);
              return;
            }
          }
          if (e.key === 'ArrowUp' && !draft && recall && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            changeDraft(recall);
            return;
          }
          if (shouldSend({ ...e, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode }, sendKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <span className="sr-only" id="send-help">
        {sendKey === 'enter' ? t.sendEnterHint : t.sendHint}
      </span>
    </>
  );
}
