/* Convert the rich_text tool's final-answer blocks into Markdown for chat. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.chatRichText = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function resultText(result) {
    const blocks = result?.details?.blocks;
    if (Array.isArray(blocks)) {
      return blocks.map(block => {
        if (!block || typeof block.text !== 'string') return '';
        const text = block.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        switch (block.kind) {
          case 'title': return '# ' + text.replace(/\n/g, ' ');
          case 'heading': return '## ' + text.replace(/\n/g, ' ');
          case 'bullet': return '- ' + text.replace(/\n/g, '\n  ');
          case 'quote': return text.split('\n').map(line => '> ' + line).join('\n');
          case 'code': return text.split('\n').map(line => '    ' + line).join('\n');
          case 'divider': return '---';
          case 'spacer': return '';
          default: return text;
        }
      }).join('\n\n').trim();
    }
    return Array.isArray(result?.content)
      ? result.content.filter(part => part && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
      : typeof result?.content === 'string' ? result.content : '';
  }
  return { resultText };
});
