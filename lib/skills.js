'use strict';
const fs = require('fs');
const path = require('path');

const validId = id => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 100;
function metadata(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Skill is too large.');
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Missing skill frontmatter.');
  const field = key => {
    const line = new RegExp('^' + key + ':[^\\S\\r\\n]*(.*)$', 'm').exec(match[1]);
    if (!line) return '';
    let value = line[1].trim();
    // Skill authors commonly use YAML folded/literal descriptions. The picker
    // needs one line, regardless of how that description is laid out in YAML.
    if (key === 'description' && /^[>|][+-]?(?:\s+#.*)?$/.test(value)) {
      const lines = match[1].slice(line.index + line[0].length).split(/\r?\n/).slice(1);
      const block = [];
      for (const next of lines) {
        if (next.trim() && !/^[ \t]/.test(next)) break;
        block.push(next.trim());
      }
      value = block.join(' ').replace(/\s+/g, ' ').trim();
    }
    if (/^['"].*['"]$/.test(value)) value = value.slice(1, -1);
    return value;
  };
  const name = field('name'), description = field('description');
  if (!validId(name) || !description || /^[>|]/.test(description)) throw new Error('Skill needs a valid name and description.');
  return { name, description, text };
}
function createSkills(root, piRoot) {
  function scan(base) {
    let entries; try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const found = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const source = path.join(base, entry.name);
      const file = entry.isDirectory() ? path.join(source, 'SKILL.md') : entry.isFile() && /\.md$/i.test(entry.name) ? source : '';
      if (!file) continue;
      try { if (fs.lstatSync(file).isSymbolicLink()) continue; const info = metadata(file); found.push({ name: info.name, description: info.description, path: file, source: entry.name }); } catch {}
    }
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  }
  function list() {
    const unique = new Map();
    for (const item of scan(root)) {
      // Accept skills saved directly as Markdown as well as skill folders.
      // A canonical name/SKILL.md takes precedence over duplicate loose files.
      if (!unique.has(item.name) || item.source === item.name) unique.set(item.name, item);
    }
    return [...unique.values()];
  }
  function availableImports() { const existing = new Set(list().map(item => item.name)); return scan(piRoot).map(item => ({ ...item, imported: existing.has(item.name) })); }
  function importSkill(source) {
    const item = availableImports().find(candidate => candidate.source === source);
    if (!item) throw new Error('Pi skill not found.');
    if (item.imported) throw new Error('A Synthesis skill with this name already exists.');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const destination = path.join(root, item.name);
    fs.mkdirSync(destination, { mode: 0o700 });
    try {
      const original = path.join(piRoot, item.source);
      if (fs.lstatSync(original).isDirectory()) {
        fs.cpSync(original, destination, { recursive: true, dereference: false, filter: src => { if (fs.lstatSync(src).isSymbolicLink()) throw new Error('Skills containing symbolic links cannot be imported.'); return true; } });
      } else fs.copyFileSync(original, path.join(destination, 'SKILL.md'));
      metadata(path.join(destination, 'SKILL.md'));
    } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
    return item.name;
  }
  function resolve(id) {
    if (!validId(id)) throw new Error('Invalid skill name.');
    const item = list().find(skill => skill.name === id);
    if (!item) throw new Error(`Synthesis skill “${id}” is unavailable.`);
    const info = metadata(item.path);
    return { ...item, text: info.text };
  }
  return { list, availableImports, importSkill, resolve };
}
function withSkill(prompt, skill) {
  return `Use the following Synthesis skill for this request. Its supporting files are in ${path.dirname(skill.path)}; resolve relative references from that directory.\n\n<skill name="${skill.name}">\n${skill.text}\n</skill>\n\nUser request:\n${prompt}`;
}
function creationGuidance(root) {
  return `Synthesis skill library: ${root}
When the user asks you to create a reusable skill, create it in this Synthesis library by default, unless the user explicitly specifies another destination. Use the absolute library path above, not a project-local or Pi skills directory. Create the library directory if needed. Use a folder named after the skill containing SKILL.md. The file must start with YAML frontmatter containing a lowercase hyphenated name matching the folder and a description; place supporting files in that folder. Do not overwrite an existing skill unless the user asks you to update it. Synthesis discovers saved skills automatically, so the skill can be used in this same session without restarting. Tell the user the skill name and that it can be invoked with $name.`;
}

function watchSkills(root, changed) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let timer = null;
  const watcher = fs.watch(root, { recursive: true, persistent: false }, () => {
    clearTimeout(timer);
    timer = setTimeout(changed, 100); timer.unref();
  });
  // Picking/focusing a skill or settling a turn also refreshes the catalogue,
  // so a filesystem watcher failure must not stop the application.
  watcher.on('error', () => { clearTimeout(timer); watcher.close(); });
  return () => { clearTimeout(timer); watcher.close(); };
}
function expandMentions(prompt, library, selectedId = '') {
  const available = new Set(library.list().map(skill => skill.name));
  const names = [];
  if (selectedId) names.push(selectedId);
  for (const match of prompt.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-zA-Z0-9_-])/g)) {
    if (available.has(match[1]) && !names.includes(match[1])) names.push(match[1]);
  }
  if (!names.length) return prompt;
  const entries = names.map(name => library.resolve(name));
  const instructions = entries.map(skill => `<skill name="${skill.name}" directory="${path.dirname(skill.path)}">\n${skill.text}\n</skill>`).join('\n\n');
  return `Use the following Synthesis skills for this request. Resolve relative references from each skill's directory.\n\n${instructions}\n\nUser request:\n${prompt}`;
}
module.exports = { createSkills, withSkill, creationGuidance, expandMentions, validId, watchSkills };
