import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTaskList, parseCommand, parseShortIdArg } from './command-router.js';

test('parseCommand: /todo with args', () => {
  const result = parseCommand('/todo buy milk');
  assert.deepEqual(result, { name: 'todo', rest: 'buy milk' });
});

test('parseCommand: plain text returns null', () => {
  assert.equal(parseCommand('hello world'), null);
});

test('parseCommand: cyrillic command name', () => {
  const result = parseCommand('/задачи 5');
  assert.deepEqual(result, { name: 'задачи', rest: '5' });
});

test('parseCommand: no args gives empty rest', () => {
  const result = parseCommand('/list');
  assert.deepEqual(result, { name: 'list', rest: '' });
});

test('parseCommand: leading whitespace tolerated', () => {
  const result = parseCommand('  /done #abc  ');
  assert.deepEqual(result, { name: 'done', rest: '#abc' });
});

test('parseCommand: name is lowercased', () => {
  const result = parseCommand('/LIST');
  assert.deepEqual(result, { name: 'list', rest: '' });
});

test('parseCommand: missing slash', () => {
  assert.equal(parseCommand('todo buy'), null);
});

test('parseCommand: empty input', () => {
  assert.equal(parseCommand(''), null);
});

test('parseShortIdArg: id + remainder', () => {
  const r = parseShortIdArg('#abc12345 2h');
  assert.equal(r.shortId, 'abc12345');
  assert.equal(r.remainder, '2h');
});

test('parseShortIdArg: id only', () => {
  const r = parseShortIdArg('#abcd1234');
  assert.equal(r.shortId, 'abcd1234');
  assert.equal(r.remainder, '');
});

test('parseShortIdArg: no id', () => {
  const r = parseShortIdArg('no id here');
  assert.equal(r.shortId, null);
  assert.equal(r.remainder, 'no id here');
});

test('parseShortIdArg: empty', () => {
  const r = parseShortIdArg('');
  assert.equal(r.shortId, null);
  assert.equal(r.remainder, '');
});

test('parseShortIdArg: id in the middle of text', () => {
  const r = parseShortIdArg('please close #abcd1234 now');
  assert.equal(r.shortId, 'abcd1234');
  assert.equal(r.remainder, 'please close  now');
});

test('parseShortIdArg: 3-char id is rejected (below 4)', () => {
  const r = parseShortIdArg('#abc rest');
  assert.equal(r.shortId, null);
});

test('formatTaskList: empty list', () => {
  const out = formatTaskList([], 'UTC');
  assert.match(out, /Задач нет/);
});

test('formatTaskList: with items', () => {
  const out = formatTaskList(
    [
      { title: 'buy bread', due: null },
      { title: 'call mom', due: '2026-04-17T10:00:00.000Z' },
    ],
    'UTC',
  );
  assert.match(out, /buy bread/);
  assert.match(out, /call mom/);
  assert.match(out, /17 апр\./);
});
