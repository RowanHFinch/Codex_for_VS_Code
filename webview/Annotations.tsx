import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Action, ViewState } from '../src/shared';
import type { ResponseAnnotation } from '../src/annotations';
import type en from '../locales/en.json';
import { Icon } from './icons';
import { annotationPosition } from './annotationPosition';

function Comment({
  value,
  label,
  change,
  focus = false,
  done,
  multiline = false,
}: {
  value: string;
  label: string;
  change: (text: string) => void;
  focus?: boolean;
  done?: () => void;
  multiline?: boolean;
}) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const pending = useRef<string[]>([]);
  useEffect(() => {
    // Older typing echoes must not replace newer input; a new value (e.g. dictation) is authoritative.
    const echoed = pending.current.indexOf(value);
    if (echoed >= 0) pending.current.splice(0, echoed + 1);
    else pending.current = [];
    if (!pending.current.length) setText(value);
  }, [value]);
  useEffect(() => {
    if (focus) input.current?.focus({ preventScroll: true });
  }, [focus]);
  const Input = multiline ? 'textarea' : 'input';
  return (
    <Input
      ref={input}
      aria-label={label}
      placeholder={label}
      maxLength={2000}
      value={text}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          done?.();
        }
      }}
      onChange={event => {
        pending.current.push(event.target.value);
        setText(event.target.value);
        change(event.target.value);
      }}
    />
  );
}

type Popup = { annotation: ResponseAnnotation; range: Range; editing: boolean };

function excerptRange(annotation: ResponseAnnotation) {
  const root = [...document.querySelectorAll<HTMLElement>('.assistant-quote-source')].find(
    node => node.dataset.itemId === annotation.itemId && node.dataset.turnId === annotation.turnId,
  );
  if (!root || root.textContent?.slice(annotation.start, annotation.end) !== annotation.text) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
    range = document.createRange();
  let offset = 0,
    started = false;
  while (walker.nextNode()) {
    const node = walker.currentNode,
      end = offset + (node.textContent?.length ?? 0);
    if (!started && annotation.start >= offset && annotation.start < end) {
      range.setStart(node, annotation.start - offset);
      started = true;
    }
    if (started && annotation.end <= end) {
      range.setEnd(node, annotation.end - offset);
      return range;
    }
    offset = end;
  }
}

export function Annotations({
  state,
  t,
  post,
  dictate,
  cancelDictation,
}: {
  state: ViewState;
  t: typeof en;
  post: (action: Action) => void;
  dictate: (annotationId: string) => void;
  cancelDictation: (annotationId: string) => void;
}) {
  const [popup, setPopup] = useState<Popup>();
  const [markers, setMarkers] = useState<
    { annotation: ResponseAnnotation; range: Range; left: number; top: number; index: number }[]
  >([]);
  const cancelRef = useRef<() => void>(() => {});
  const floating = useRef<HTMLDivElement>(null);
  const annotations = state.annotations ?? [];
  const close = () => {
    setPopup(undefined);
    window.getSelection()?.removeAllRanges();
  };
  useEffect(() => {
    if (state.status === 'starting') close();
  }, [state.status]);
  useEffect(() => {
    close();
    const select = (event: Event) => {
      if ((event.target as Element)?.closest?.('.annotation-popup, .annotation-marker')) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return setPopup(undefined);
      const range = selection.getRangeAt(0);
      const root = (
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement
      )?.closest<HTMLElement>('.assistant-quote-source');
      if (!root || !root.contains(range.endContainer) || !range.toString().trim()) return setPopup(undefined);
      const prefix = range.cloneRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length,
        text = range.toString();
      setPopup({
        annotation: {
          id: crypto.randomUUID(),
          itemId: root.dataset.itemId!,
          turnId: root.dataset.turnId!,
          text,
          comment: '',
          start,
          end: start + text.length,
        },
        range: range.cloneRange(),
        editing: false,
      });
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelRef.current();
      else if (event.shiftKey && event.key.startsWith('Arrow')) select(event);
    };
    const dismiss = (event: Event) => {
      if (!(event.target as Element)?.closest?.('.annotation-popup, .annotation-marker')) close();
    };
    document.addEventListener('mouseup', select);
    document.addEventListener('keyup', keys);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mouseup', select);
      document.removeEventListener('keyup', keys);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [state.threadId]);
  useLayoutEffect(() => {
    const update = () => {
      const timeline = document.querySelector('.timeline')?.getBoundingClientRect();
      if (!timeline) return setMarkers([]);
      setMarkers(
        annotations.flatMap((annotation, index) => {
          const range = excerptRange(annotation);
          const rect = range && [...range.getClientRects()].filter(r => r.width && r.height).at(-1);
          if (!range || !rect || rect.top < timeline.top || rect.bottom > timeline.bottom) return [];
          return [
            {
              annotation,
              range,
              index,
              left: Math.min(window.innerWidth - 34, rect.right + 3),
              top: Math.max(timeline.top, rect.top - 21),
            },
          ];
        }),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    const timeline = document.querySelector('.timeline');
    if (timeline) observer.observe(timeline);
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [state.annotations, state.items, state.threadId]);
  useLayoutEffect(() => {
    const element = floating.current;
    if (!popup || !element) return;
    const place = () => {
      const anchor = [...popup.range.getClientRects()].find(rect => rect.width && rect.height);
      if (!anchor) return close();
      const timeline = document.querySelector('.timeline')?.getBoundingClientRect();
      const bounds = {
        left: 12,
        right: window.innerWidth - 12,
        top: Math.max(8, timeline?.top ?? 8),
        bottom: Math.min(window.innerHeight - 8, timeline?.bottom ?? window.innerHeight - 8),
      };
      // Leave room for the numbered badge between the editor and the selected line.
      const point = annotationPosition(
        popup.editing ? { ...anchor.toJSON(), top: anchor.top - 22 } : anchor,
        element.getBoundingClientRect(),
        bounds,
      );
      Object.assign(element.style, { top: `${point.top}px`, left: `${point.left}px`, visibility: 'visible' });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    const timeline = document.querySelector('.timeline');
    if (timeline) observer.observe(timeline);
    return () => observer.disconnect();
  }, [popup]);
  useEffect(() => {
    // Only the excerpt currently being edited is highlighted; saved context stays in the composer.
    if (popup?.editing && typeof Highlight !== 'undefined')
      CSS.highlights.set('response-annotations', new Highlight(popup.range));
    return () => {
      if (typeof Highlight !== 'undefined') CSS.highlights.delete('response-annotations');
    };
  }, [popup]);
  const change = (id: string, text: string) => post({ type: 'commentAnnotation', threadId: state.threadId!, id, text });
  const cancel = () => {
    if (popup?.editing) {
      cancelDictation(popup.annotation.id);
      change(popup.annotation.id, popup.annotation.comment);
    }
    close();
  };
  cancelRef.current = cancel;
  const remove = (id: string) => {
    cancelDictation(id);
    post({ type: 'removeAnnotation', threadId: state.threadId!, id });
    close();
  };
  const voice = state.voice;
  const voiceBusy = Boolean(voice && voice.status !== 'idle');
  const microphone = (id: string) => (
    <button
      className="icon-button"
      aria-label={voiceBusy && voice?.annotationId === id ? t.voiceStop : t.dictate}
      title={voiceBusy && voice?.annotationId === id ? t.voiceStop : t.dictate}
      disabled={!state.runtimeVersion || (voiceBusy && (voice?.annotationId !== id || voice.status !== 'recording'))}
      onClick={() => dictate(id)}
    >
      <Icon
        name={voiceBusy && voice?.annotationId === id ? (voice.status === 'recording' ? 'stop' : 'spinner') : 'mic'}
      />
    </button>
  );
  return (
    <>
      {annotations.length ? (
        <details className="annotation-list composer-annotations">
          <summary>
            <Icon name="comment" />
            <span>
              {annotations.length === 1
                ? t.responseAnnotation
                : t.responseAnnotations.replace('{count}', String(annotations.length))}
            </span>
          </summary>
          {annotations.map((a, index) => (
            <div className="annotation-entry" key={a.id}>
              <span className="annotation-number">{index + 1}</span>
              <div>
                <blockquote>{a.text}</blockquote>
                <div className="annotation-comment-row">
                  <Comment
                    value={a.comment}
                    label={`${index + 1} · ${t.annotationComment}`}
                    change={text => change(a.id, text)}
                  />
                  {microphone(a.id)}
                </div>
              </div>
              <button
                className="icon-button"
                aria-label={`${t.removeAnnotation} ${index + 1}`}
                onClick={() => remove(a.id)}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </details>
      ) : null}
      {createPortal(
        markers.map(marker => (
          <button
            key={marker.annotation.id}
            className="annotation-number annotation-marker"
            style={{ left: marker.left, top: marker.top }}
            aria-label={`${t.editAnnotation} ${marker.index + 1}`}
            title={`${t.editAnnotation} ${marker.index + 1}`}
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setPopup({ annotation: { ...marker.annotation }, range: marker.range, editing: true });
            }}
          >
            {marker.index + 1}
          </button>
        )),
        document.body,
      )}
      {popup
        ? createPortal(
            <div
              ref={floating}
              className={`annotation-popup${popup.editing ? ' editing' : ''}`}
              style={{ visibility: 'hidden' }}
              role={popup.editing ? 'group' : undefined}
              aria-label={popup.editing ? t.annotationComment : undefined}
            >
              {popup.editing ? (
                <>
                  <Comment
                    focus
                    multiline
                    value={annotations.find(a => a.id === popup.annotation.id)?.comment ?? ''}
                    label={t.annotationComment}
                    change={text => change(popup.annotation.id, text)}
                    done={close}
                  />
                  <div className="annotation-actions">
                    <button
                      className="icon-button annotation-delete"
                      aria-label={t.removeAnnotation}
                      title={t.removeAnnotation}
                      onClick={() => remove(popup.annotation.id)}
                    >
                      <Icon name="trash" />
                    </button>
                    <span className="annotation-action-spacer" />
                    {microphone(popup.annotation.id)}
                    <button className="annotation-cancel" onClick={cancel}>
                      {t.cancel}
                    </button>
                    <button className="annotation-save" onClick={close}>
                      {t.saveAnnotation}
                    </button>
                  </div>
                </>
              ) : (
                <button
                  disabled={annotations.length >= 10 || popup.annotation.text.length > 8000}
                  title={
                    annotations.length >= 10 || popup.annotation.text.length > 8000 ? t.annotationLimit : undefined
                  }
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => {
                    post({ type: 'addAnnotation', threadId: state.threadId!, annotation: popup.annotation });
                    setPopup({ ...popup, editing: true });
                    window.getSelection()?.removeAllRanges();
                  }}
                >
                  {t.addToChat}
                </button>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
