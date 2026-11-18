import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cjkShare, hasForm, inventory, modelText, parseTerms, proseOf, reviewSection, sections, termsIn, upsertTerm, words } from './lib.ts';

const page = (...lines: string[]) => lines.join('\n');

test('sections splits at h1-h4 headings and ignores headings inside code fences', () => {
  const parts = sections(page('---', 'title: A', '---', 'intro', '## One', 'text', '```md', '## not a heading', '```', '### Two', 'more'));
  assert.deepEqual(parts.map((part) => part.heading), ['Frontmatter and intro', '## One', '### Two']);
  assert.ok(parts[1]?.lines.includes('## not a heading'));
});

test('proseOf drops code, links, urls, and tags, and keeps the text of attributes once', () => {
  const text = proseOf([
    '<Card',
    '  title="Quickstart"',
    '  href="/quickstart"',
    '>',
    '  Run `e2e init` and read [the guide](/guide) at https://example.com now.',
    '</Card>',
    '```ts',
    'const hidden = 1;',
    '```',
  ]);
  assert.equal(text.split('\n').filter((line) => line.includes('Quickstart')).length, 1);
  assert.ok(text.includes('Run') && text.includes('the guide'));
  assert.ok(!text.includes('hidden') && !text.includes('/guide') && !text.includes('example.com') && !text.includes('href'));
});

test('modelText marks code blocks, drops imports and tags, and keeps inline code', () => {
  const text = modelText(['import X from "./x"', '<Note title="Heads up">', 'Use `agent.act` here.', '</Note>', '```ts', 'secret();', '```']);
  assert.ok(text.includes('[code block]') && text.includes('Heads up') && text.includes('`agent.act`'));
  assert.ok(!text.includes('import') && !text.includes('secret()') && !text.includes('<Note'));
});

test('words counts each CJK character as a word and splits other scripts on spaces', () => {
  assert.deepEqual(words('Run テスト now'), ['run', 'テ', 'ス', 'ト', 'now']);
  assert.ok(cjkShare('これはテストです') > 0.9);
  assert.ok(cjkShare('this is a test') === 0);
});

test('parseTerms reads escaped pipes, alignment separators, and skips the header', () => {
  const terms = parseTerms(['| English | Español | Notas |', '|:---|:---:|---|', '| agent | agente / agentes |  |', '| pipe | a \\| b | has a pipe |'].join('\n'));
  assert.deepEqual(terms.map((term) => term.en), ['agent', 'pipe']);
  assert.deepEqual(terms[0]?.forms, ['agente', 'agentes']);
  assert.equal(terms[1]?.forms[0], 'a | b');
});

test('hasForm matches a word start, and a space and a hyphen stand for each other', () => {
  assert.ok(hasForm('Los agentes corren', 'agente'));
  assert.ok(!hasForm('el reagente', 'agente'));
  assert.ok(hasForm('Inicia-sesión aquí', 'inicia sesión'));
});

test('hasForm finds a CJK form inside text with no spaces', () => {
  assert.ok(hasForm('このエージェントは動きます', 'エージェント'));
});

test('termsIn matches an English term at word boundaries, with a plural, and across a hyphen', () => {
  const terms = [{ en: 'agent', forms: ['agente'], note: '' }, { en: 'test', forms: ['test'], note: '' }, { en: 'sign in', forms: ['iniciar sesión'], note: '' }];
  assert.deepEqual(termsIn('Agents run the latest build and sign-in.', terms).map((term) => term.en), ['agent', 'sign in']);
});

test('inventory counts markdown links, component hrefs, list items, table rows, and code blocks', () => {
  const counts = inventory(['- [a](/one)', '- b', '<Card href="/two" />', '| x | y |', '```ts', 'code', '```']);
  assert.equal(counts.links.get('/one'), 1);
  assert.equal(counts.links.get('/two'), 1);
  assert.equal([counts.listItems, counts.tableRows, counts.codeBlocks].join(','), '2,1,2');
});

const english = { heading: '## A', lines: ['## A', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix'] };

test('reviewSection reports a missing link, cut prose, and a term that drifted', () => {
  const source = { heading: '## A', lines: ['## A', ...english.lines.slice(1), 'See [agents](/agents).'] };
  const cut = { heading: '## A', lines: ['## A', 'uno'] };
  const kinds = new Set(reviewSection('p.mdx', '## A', source, cut, [{ en: 'agents', forms: ['agentes'], note: '' }]).map((finding) => finding.kind));
  assert.ok(kinds.has('missing-links') && kinds.has('short') && kinds.has('term'));
});

test('reviewSection flags prose left in English', () => {
  const kinds = reviewSection('p.mdx', '## A', english, english, []).map((finding) => finding.kind);
  assert.ok(kinds.includes('untranslated'));
});

test('reviewSection skips the length checks for CJK text and finds a CJK term form', () => {
  const japanese = { heading: '## A', lines: ['## A', 'これは短い。'] };
  const findings = reviewSection('p.mdx', '## A', english, japanese, [{ en: 'twelve', forms: ['短い'], note: '' }]);
  assert.deepEqual(findings.map((finding) => finding.kind), []);
});

const table = ['# Terms', '', '| English | Español | Notas |', '| --- | --- | --- |', '| agent | agente / agentes |  |', '| worker | worker |  |', ''].join('\n');

test('upsertTerm inserts a row in alphabetical order', () => {
  const result = upsertTerm(table, 'goal', 'objetivo / objetivos', 'why');
  const names = parseTerms(result.text).map((term) => term.en);
  assert.deepEqual(names, ['agent', 'goal', 'worker']);
  assert.equal(result.message, 'added "goal" -> objetivo / objetivos');
});

test('upsertTerm replaces the forms of a row that exists, ignoring case', () => {
  const result = upsertTerm(table, 'Agent', 'agente / agentes / agencia');
  assert.equal(parseTerms(result.text)[0]?.forms.length, 3);
  assert.ok(result.message.startsWith('updated "agent"'));
});

test('upsertTerm refuses a table with a row it would drop', () => {
  const broken = table.replace('| worker | worker |  |', '| English | oops |  |');
  assert.throws(() => upsertTerm(broken, 'goal', 'objetivo'), /no row is dropped/);
});
