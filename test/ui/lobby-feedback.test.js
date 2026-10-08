import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEEDBACK_GROUP, copyFeedbackGroup } from '../../public/js/ui/lobbyFeedback.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('lobby feedback copies only the existing public group number', async () => {
  const copied = [], messages = [];
  assert.equal(FEEDBACK_GROUP, '815818430');
  assert.equal(await copyFeedbackGroup(async text => { copied.push(text); return true; }, (...args) => messages.push(args)), true);
  assert.deepEqual(copied, ['815818430']);
  assert.deepEqual(messages, [['已复制反馈群号 815818430', 'success']]);
});

for (const mode of ['unavailable', 'denied']) test(`lobby feedback ${mode} does not claim successful copying`, async () => {
  const messages = [];
  const copy = async text => { assert.equal(text, '815818430'); if (mode === 'denied') throw new Error('denied'); return false; };
  assert.equal(await copyFeedbackGroup(copy, (...args) => messages.push(args)), false);
  assert.deepEqual(messages, [['复制失败，请手动复制', 'warn']]);
});

test('feedback remains visible outside optional announcements, with a number-only accessible button', () => {
  const lobby = source('../../public/js/screens/lobby.js'), feedback = source('../../public/js/ui/lobbyFeedback.js');
  assert.match(lobby, /<aside class="lobby-contact"><\$\{LobbyFeedback\} \/><\/aside>/);
  assert.match(feedback, /aria-label=\$\{t\('反馈 QQ 群：\{group\}，点击复制群号'/);
  assert.match(feedback, />\$\{FEEDBACK_GROUP\}<\/\/>/);
  assert.doesNotMatch(feedback, /href=|window\.open|2225664821|net\.request|localStorage/);
  assert.match(feedback, /copied \? 'success' : 'warn'/);
  const css = source('../../public/css/screens/lobby.css');
  assert.match(css, /\.lobby-feedback \{[^}]*min-height: 40px/);
});
