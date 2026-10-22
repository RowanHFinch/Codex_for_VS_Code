import React, { useEffect, useRef, useState } from 'react';
import type { Action, Decision } from '../src/shared';
import { validateElicitation, type FormValue } from '../src/runtime/elicitation';
import type en from '../locales/en.json';

export function McpForm({ decision, t, post }: { decision: Decision; t: typeof en; post(action: Action): void }) {
  const form = decision.form!;
  const element = useRef<HTMLFormElement>(null);
  useEffect(() => {
    element.current?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
    element.current?.scrollIntoView({ block: 'start' });
  }, []);
  const [content, setContent] = useState<Record<string, FormValue>>(() =>
    Object.fromEntries(
      form.fields.flatMap(f =>
        f.default !== undefined
          ? [[f.name, f.default]]
          : f.required && f.type === 'string' && !f.options && !f.minLength && !f.format
            ? [[f.name, '']]
            : [],
      ),
    ),
  );
  const [submitted, setSubmitted] = useState(false);
  let valid = true;
  try {
    validateElicitation(form.fields, content);
  } catch {
    valid = false;
  }
  const update = (name: string, value?: FormValue) =>
    setContent(previous => {
      const next = { ...previous };
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    });
  return (
    <form
      ref={element}
      className="decision mcp-form"
      aria-label={t.mcpForm}
      onSubmit={event => {
        event.preventDefault();
        if (!valid || !decision.canAccept || submitted) return;
        post({ type: 'decision', id: decision.id, token: decision.token, accept: true, content });
        setContent({});
        setSubmitted(true);
      }}
    >
      <h3 tabIndex={-1}>
        {t.mcpForm} · {form.serverName}
      </h3>
      <p>
        {t.decisionSource}: {decision.threadId}
      </p>
      <p className="preserve-lines">{form.message}</p>
      <p className="muted">{t.mcpFormHelp}</p>
      <fieldset disabled={!decision.canAccept || submitted}>
        {form.fields.map((f, i) => {
          const id = `${decision.token}-${i}`,
            description = `${id}-help`,
            value = content[f.name];
          return (
            <div className="mcp-field" key={f.name}>
              <label htmlFor={id}>
                {f.title}
                {f.required ? ' *' : ''}
              </label>
              {f.description ? <small id={description}>{f.description}</small> : null}
              {f.type === 'array' ? (
                <fieldset id={id} aria-label={f.title} aria-describedby={f.description ? description : undefined}>
                  {f.options!.map(option => (
                    <label className="option" key={option.value}>
                      <input
                        type="checkbox"
                        checked={Array.isArray(value) && value.includes(option.value)}
                        onChange={event =>
                          update(
                            f.name,
                            event.target.checked
                              ? [...(Array.isArray(value) ? value : []), option.value]
                              : (value as string[]).filter(v => v !== option.value),
                          )
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
              ) : f.type === 'boolean' || f.options ? (
                <select
                  id={id}
                  aria-describedby={f.description ? description : undefined}
                  required={f.required}
                  value={
                    value === undefined
                      ? ''
                      : f.type === 'boolean'
                        ? String(value)
                        : `v${f.options!.findIndex(o => o.value === value)}`
                  }
                  onChange={event =>
                    update(
                      f.name,
                      event.target.value === ''
                        ? undefined
                        : f.type === 'boolean'
                          ? event.target.value === 'true'
                          : f.options![Number(event.target.value.slice(1))].value,
                    )
                  }
                >
                  <option value="">{t.chooseAnswer}</option>
                  {f.type === 'boolean' ? (
                    <>
                      <option value="true">{t.yes}</option>
                      <option value="false">{t.no}</option>
                    </>
                  ) : (
                    f.options!.map((o, index) => (
                      <option key={o.value} value={`v${index}`}>
                        {o.label}
                      </option>
                    ))
                  )}
                </select>
              ) : (
                <input
                  id={id}
                  aria-describedby={f.description ? description : undefined}
                  type={
                    f.type === 'number' || f.type === 'integer'
                      ? 'number'
                      : f.format === 'email'
                        ? 'email'
                        : f.format === 'date'
                          ? 'date'
                          : 'text'
                  }
                  step={f.type === 'integer' ? 1 : 'any'}
                  min={f.minimum}
                  max={f.maximum}
                  minLength={f.minLength}
                  maxLength={Math.min((f.maxLength ?? 10_000) * 2, 10_000)}
                  required={f.required && (f.type !== 'string' || (f.minLength ?? 0) > 0)}
                  value={typeof value === 'number' || typeof value === 'string' ? value : ''}
                  autoComplete="off"
                  onChange={event =>
                    update(
                      f.name,
                      f.type === 'string'
                        ? event.target.value === '' && !f.required
                          ? undefined
                          : event.target.value
                        : event.target.value === ''
                          ? undefined
                          : Number(event.target.value),
                    )
                  }
                />
              )}
            </div>
          );
        })}
      </fieldset>
      {!valid && !submitted ? <p className="muted">{t.formIncomplete}</p> : null}
      <div className="actions">
        <button type="submit" disabled={!valid || !decision.canAccept || submitted}>
          {t.submit}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={submitted}
          onClick={() => {
            setContent({});
            post({ type: 'decision', id: decision.id, token: decision.token });
            setSubmitted(true);
          }}
        >
          {t.decline}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={submitted}
          onClick={() => {
            setContent({});
            post({ type: 'decision', id: decision.id, token: decision.token, cancel: true });
            setSubmitted(true);
          }}
        >
          {t.cancelQuestion}
        </button>
      </div>
    </form>
  );
}
