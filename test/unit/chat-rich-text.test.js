'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resultText } = require('../../lib/chat-rich-text');

test('renders rich text tool blocks as readable Markdown', () => {
  assert.equal(resultText({ details: { blocks: [
    { kind: 'title', text: 'Report' }, { kind: 'paragraph', text: 'Summary' },
    { kind: 'bullet', text: 'First\ncontinued' }, { kind: 'quote', text: 'quoted' },
    { kind: 'code', text: 'let x = 1;\n```' }, { kind: 'divider', text: '' }
  ] } }), '# Report\n\nSummary\n\n- First\n  continued\n\n> quoted\n\n    let x = 1;\n    ```\n\n---');
});

test('falls back to text content and strips terminal control characters in blocks', () => {
  assert.equal(resultText({ content: [{ type: 'text', text: 'Answer' }] }), 'Answer');
  assert.equal(resultText({ details: { blocks: [{ kind: 'paragraph', text: 'A\u001bB' }] } }), 'AB');
  assert.equal(resultText({}), '');
});
