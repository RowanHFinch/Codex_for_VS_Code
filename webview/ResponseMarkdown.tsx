import React, { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Action } from '../src/shared';

// Parsing completed responses must not repeat on every keystroke, token or editor-context update.
export const ResponseMarkdown = memo(function ResponseMarkdown({
  text,
  post,
}: {
  text: string;
  post: (action: Action) => void;
}) {
  return (
    <Markdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={event => {
              event.preventDefault();
              if (href) post({ type: 'link', url: href });
            }}
          >
            {children}
          </a>
        ),
        img: () => null,
      }}
    >
      {text}
    </Markdown>
  );
});
