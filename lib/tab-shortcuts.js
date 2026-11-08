'use strict';

// Native browser views receive keyboard input separately from the app renderer.
// Match only configured tab actions, leaving editing and page shortcuts intact.
function tabActionForInput(input, bindings) {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null;
  const key = ({ ' ': 'Space', ',': 'Comma', '.': 'Period', '+': 'Plus', '-': 'Minus' })[input.key]
    || (input.key.length === 1 ? input.key.toUpperCase() : input.key);
  const binding = [input.meta && 'Meta', input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', key].filter(Boolean).join('+');
  return Object.keys(bindings).find((action) => bindings[action] === binding) || null;
}

module.exports = { tabActionForInput };
