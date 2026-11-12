'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSkills, withSkill } = require('../../lib/skills');

test('Pi skills are copied into an independent library and resolved explicitly', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-skills-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const pi = path.join(base, 'pi'), root = path.join(base, 'synthesis'); fs.mkdirSync(pi); fs.mkdirSync(path.join(pi, 'writing'));
  const source = path.join(pi, 'writing', 'SKILL.md');
  fs.writeFileSync(source, '---\nname: writing\ndescription: Help write\n---\nUse the guide.');
  fs.writeFileSync(path.join(pi, 'writing', 'guide.txt'), 'Guide');
  const library = createSkills(root, pi);
  assert.deepEqual(library.list(), []);
  assert.equal(library.availableImports()[0].name, 'writing');
  library.importSkill('writing');
  fs.writeFileSync(source, 'changed');
  assert.equal(fs.readFileSync(path.join(root, 'writing', 'guide.txt'), 'utf8'), 'Guide');
  const skill = library.resolve('writing');
  assert.match(withSkill('Draft this', skill), /Use the guide\.[\s\S]*Draft this/);
  assert.throws(() => library.resolve('../writing'));
  assert.throws(() => library.importSkill('writing'));
});

test('imports single-file skills and refuses symlinks and collisions', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-skills-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const pi = path.join(base, 'pi'), root = path.join(base, 'synthesis'); fs.mkdirSync(pi);
  fs.writeFileSync(path.join(pi, 'One.md'), '---\nname: one\ndescription: One skill\n---\nBody');
  fs.mkdirSync(path.join(pi, 'unsafe')); fs.writeFileSync(path.join(pi, 'unsafe', 'SKILL.md'), '---\nname: unsafe\ndescription: Unsafe\n---\nBody');
  fs.symlinkSync(path.join(pi, 'One.md'), path.join(pi, 'unsafe', 'linked'));
  const library = createSkills(root, pi); library.importSkill('One.md');
  assert.equal(library.resolve('one').name, 'one');
  assert.throws(() => library.importSkill('unsafe'), /symbolic links/);
  assert.equal(fs.existsSync(path.join(root, 'unsafe')), false);
});

test('dollar mentions activate matching skills anywhere, once each, without changing ordinary dollar text', t => {
  const { expandMentions, creationGuidance } = require('../../lib/skills');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-mentions-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const name of ['writing', 'research']) {
    fs.mkdirSync(path.join(base, name));
    fs.writeFileSync(path.join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: A skill\n---\n${name} instructions`);
  }
  const library = createSkills(base, path.join(base, 'pi'));
  const input = 'Please use $writing and $research, then $writing. Cost $20. Unknown $unknown.';
  const expanded = expandMentions(input, library);
  assert.match(expanded, /writing instructions/); assert.match(expanded, /research instructions/);
  assert.equal((expanded.match(/<skill name="writing"/g) || []).length, 1);
  assert.ok(expanded.endsWith(input));
  assert.equal(expandMentions('Cost $20 and $unknown', library), 'Cost $20 and $unknown');
  assert.match(expandMentions('prefix$writing suffix', library), /writing instructions/);
  assert.equal((expandMentions('$writing', library, 'writing').match(/<skill name="writing"/g) || []).length, 1);
  assert.throws(() => expandMentions('Work', library, 'missing'), /unavailable/);
  assert.match(creationGuidance(base), /create it in this Synthesis library by default/);
  assert.ok(creationGuidance(base).includes(base));
});

test('new Synthesis skills are available immediately, with flat files and multiline descriptions', t => {
  const { expandMentions } = require('../../lib/skills');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-created-skills-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'synthesis'), pi = path.join(base, 'pi');
  fs.mkdirSync(root); fs.mkdirSync(pi);
  fs.writeFileSync(path.join(pi, 'shared.md'), '---\nname: shared\ndescription: Pi only\n---\nNever auto-load.');
  const library = createSkills(root, pi);
  assert.deepEqual(library.list(), []);
  const file = path.join(root, 'A new skill.md');
  fs.writeFileSync(file, '---\nname: created-here\ndescription: >-\n  A newly created skill\n  available in the same session.\n---\nOriginal instructions.');
  assert.equal(library.list()[0].description, 'A newly created skill available in the same session.');
  assert.match(expandMentions('$created-here', library), /Original instructions/);
  assert.equal(expandMentions('$shared', library), '$shared', 'Pi skills stay out of the picker and explicit expansion');
  fs.mkdirSync(path.join(root, 'created-here'));
  fs.writeFileSync(path.join(root, 'created-here', 'SKILL.md'), '---\nname: created-here\ndescription: |\n  Canonical description\n  across lines.\n---\nUpdated instructions.');
  assert.equal(library.list().length, 1);
  assert.match(expandMentions('$created-here', library), /Updated instructions/);
  fs.writeFileSync(path.join(root, 'invalid.md'), '---\nname:\ndescription: Missing name\n---\nBody');
  assert.equal(library.list().length, 1, 'partial writes are not treated as skills');
});
