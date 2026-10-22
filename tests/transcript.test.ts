import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { splitUserMessage, UserMessage } from '../webview/UserMessage';
import { chatTitle, fallbackTitle } from '../src/sessions/title';
import { appendReasoningDelta, timelineItem, upsertItem } from '../src/runtime/events';

test('context chips preserve the exact question, file paths and selected code', () => {
  const prompt = '这段代码是什么意思？';
  const text =
    prompt +
    '\n\n[Referenced file: /workspace/test.py]\n\n--- Selected code: other.py:2-3 ---\nassert 1 < 2\n--- End of selection ---';
  assert.deepEqual(splitUserMessage(text), {
    text: prompt,
    contexts: [
      { label: '/workspace/test.py', text: undefined },
      { label: 'other.py:2-3', text: 'assert 1 < 2' },
    ],
  });
  for (const plain of [
    '[Referenced file: literal]',
    'Explain\n\n[Referenced file: a]\nwith a trailing question',
    '--- Selected code: snippet ---',
  ])
    assert.deepEqual(splitUserMessage(plain), { text: plain, contexts: [] });
  const html = renderToStaticMarkup(React.createElement(UserMessage, { text }));
  assert.match(html, /<details/);
  assert.match(html, /test.py/);
  assert.match(html, /assert 1 &lt; 2/);
  assert.doesNotMatch(html, /Referenced file:/);
});

test('titles reject malformed input and streamed summaries remain bounded and turn scoped', () => {
  for (const args of [null, [], {}, { title: 42 }, { title: '' }, { title: 'x'.repeat(81) }, { title: 'line\nbreak' }])
    assert.equal(chatTitle(args), undefined);
  assert.equal(chatTitle({ title: '  解释断言  ' }), '解释断言');
  assert.equal(
    fallbackTitle('这是啥？ --- Selected code: test.py:2-2 --- assert --- End of selection ---'),
    '这是啥？',
  );
  assert.equal(fallbackTitle('Explain\nthis\n\n[Referenced file: test.py]'), 'Explain this');
  let items = appendReasoningDelta([], 'one', 'r', 0, 'x'.repeat(200001));
  assert.equal(items[0].text.length, 200000);
  assert.equal(items[0].truncated, true);
  items = appendReasoningDelta(items, 'two', 'r', 0, 'independent');
  assert.equal(items.length, 2);
  assert.equal(items[1].text, 'independent');
  const completed = upsertItem(items, timelineItem({ type: 'reasoning', id: 'r', summary: [], content: [] }, 'two'));
  assert.equal(completed[1].text, 'independent', 'an empty completion must not erase a streamed summary');
  assert.equal(completed[1].status, 'completed');
  assert.equal(appendReasoningDelta(items, 'two', 'r', -1, 'bad'), items);
  assert.equal(
    timelineItem(
      { id: 'a', type: 'agentMessage', text: 'Progress', phase: 'commentary', memoryCitation: null, delivery: null },
      't',
    ).phase,
    'commentary',
  );
});
