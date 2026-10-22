import { splitAnnotations } from '../src/annotations';
import en from '../locales/en.json';
import React from 'react';
import { Icon } from './icons';

/** Only recognize the host's appended context suffix; keep arbitrary user text intact. */
export function splitUserMessage(text: string) {
  const suffix = text.match(
    /((?:\n\n\[Referenced file: [^\n]+\]|\n\n--- Selected code: [^\n]+ ---\n[\s\S]*?\n--- End of selection ---)+)$/,
  );
  const contexts = [
    ...(suffix?.[0] ?? '').matchAll(
      /\[Referenced file: ([^\n]+)\]|--- Selected code: ([^\n]+) ---\n([\s\S]*?)\n--- End of selection ---/g,
    ),
  ].map(match => ({ label: match[1] ?? match[2], text: match[3] }));
  return { text: suffix ? text.slice(0, suffix.index) : text, contexts };
}

export function UserMessage({ text, t = en }: { text: string; t?: typeof en }) {
  const message = splitUserMessage(text);
  const quoted = splitAnnotations(message.text);
  return (
    <>
      {quoted.text ? <div className="user-text">{quoted.text}</div> : null}
      {quoted.annotations.length ? (
        <details className="annotation-list sent-annotations">
          <summary>
            {quoted.annotations.length === 1
              ? t.responseAnnotation
              : t.responseAnnotations.replace('{count}', String(quoted.annotations.length))}
          </summary>
          {quoted.annotations.map((a, index) => (
            <div key={index}>
              <blockquote>{a.text}</blockquote>
              {a.comment ? <p>{a.comment}</p> : null}
            </div>
          ))}
        </details>
      ) : null}
      {message.contexts.length ? (
        <div className="message-contexts">
          {message.contexts.map((context, index) => (
            <details key={index} className="message-context">
              <summary title={context.label}>
                <Icon name="file" />
                <span>{context.label.split(/[\\/]/).at(-1)}</span>
              </summary>
              <pre>{context.text ?? context.label}</pre>
            </details>
          ))}
        </div>
      ) : null}
    </>
  );
}
