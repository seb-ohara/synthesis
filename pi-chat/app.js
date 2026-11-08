const prompt = document.querySelector('#prompt');
const form = document.querySelector('#composer');
const send = form.querySelector('.send');
const menu = document.querySelector('#skill-menu');
const list = document.querySelector('#skill-list');
const messages = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const history = document.querySelector('#history');
const title = document.querySelector('.top-title');
const skills = [
  { name: 'brainstorm', description: 'Explore ideas and possibilities', icon: '✳' },
  { name: 'write', description: 'Draft and refine writing', icon: '✎' },
  { name: 'research', description: 'Investigate a topic', icon: '◈' },
  { name: 'summarize', description: 'Make the essentials clear', icon: '≡' }
];
let chats = [], active = null, selected = 0, matches = [], slashStart = -1;
function update() {
  send.disabled = !prompt.value.trim();
  prompt.style.height = 'auto'; prompt.style.height = Math.min(prompt.scrollHeight, 180) + 'px';
  const before = prompt.value.slice(0, prompt.selectionStart);
  const match = before.match(/(?:^|\s)\/([\w-]*)$/);
  if (!match) { menu.hidden = true; return; }
  slashStart = before.lastIndexOf('/');
  matches = skills.filter(s => s.name.includes(match[1].toLowerCase()));
  selected = Math.min(selected, Math.max(0, matches.length - 1));
  renderSkills(); menu.hidden = false;
}
function renderSkills() {
  list.replaceChildren();
  if (!matches.length) { const empty = document.createElement('div'); empty.className = 'no-skills'; empty.textContent = 'No matching skills'; list.append(empty); return; }
  matches.forEach((skill, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'skill-option' + (index === selected ? ' selected' : '');
    const icon = document.createElement('span'); icon.className = 'skill-icon'; icon.textContent = skill.icon;
    const text = document.createElement('span'); const name = document.createElement('strong'); name.textContent = '/' + skill.name; const description = document.createElement('small'); description.textContent = skill.description; text.append(name, description); button.append(icon, text);
    button.addEventListener('click', () => choose(index)); list.append(button);
  });
}
function choose(index) {
  const end = prompt.selectionStart; prompt.value = prompt.value.slice(0, slashStart) + '/' + matches[index].name + ' ' + prompt.value.slice(end); const pos = slashStart + matches[index].name.length + 2; prompt.focus(); prompt.setSelectionRange(pos, pos); menu.hidden = true; send.disabled = false;
}
function render() {
  messages.replaceChildren(); welcome.hidden = !!active && active.messages.length > 0;
  if (active) active.messages.forEach(item => { const el = document.createElement('div'); el.className = 'message ' + item.role; el.textContent = item.text; messages.append(el); });
  history.replaceChildren();
  if (!chats.length) { const el = document.createElement('div'); el.className = 'empty-history'; el.textContent = 'Your chats will appear here.'; history.append(el); }
  chats.forEach(chat => { const button = document.createElement('button'); button.textContent = chat.name; button.className = chat === active ? 'active' : ''; button.addEventListener('click', () => { active = chat; render(); }); history.append(button); });
  title.textContent = active ? active.name : 'New chat';
  document.querySelector('#conversation').scrollTop = document.querySelector('#conversation').scrollHeight;
}
form.addEventListener('submit', e => { e.preventDefault(); const value = prompt.value.trim(); if (!value) return; if (!active) { active = { name: value.slice(0, 35), messages: [] }; chats.unshift(active); } active.messages.push({role:'user', text:value}, {role:'notice', text:'Pi is not connected in this preview. Your message has not been sent.'}); prompt.value = ''; menu.hidden = true; update(); render(); });
prompt.addEventListener('input', () => { selected = 0; update(); });
prompt.addEventListener('click', update);
prompt.addEventListener('keydown', e => { if (!menu.hidden) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (matches.length) selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; renderSkills(); return; } if (e.key === 'Escape') { e.preventDefault(); menu.hidden = true; return; } if ((e.key === 'Enter' || e.key === 'Tab') && matches.length) { e.preventDefault(); choose(selected); return; } } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
document.querySelector('#new-chat').addEventListener('click', () => { active = null; prompt.value = ''; update(); render(); prompt.focus(); document.querySelector('#sidebar').classList.remove('open'); });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { prompt.value = button.dataset.prompt; update(); prompt.focus(); }));
document.querySelector('#open-sidebar').addEventListener('click', () => document.querySelector('#sidebar').classList.add('open'));
document.querySelector('#close-sidebar').addEventListener('click', () => document.querySelector('#sidebar').classList.remove('open'));
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.querySelector('#new-chat').click(); } });
