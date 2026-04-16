import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbsoluteTime, parseRelativeDuration, parseWhen } from './duration.js';

const BASE = new Date('2026-04-16T10:00:00.000Z');

test('parseRelativeDuration: 2h adds 2 hours', () => {
  const result = parseRelativeDuration('2h', BASE);
  assert.equal(result?.toISOString(), '2026-04-16T12:00:00.000Z');
});

test('parseRelativeDuration: 30m adds 30 minutes', () => {
  const result = parseRelativeDuration('30m', BASE);
  assert.equal(result?.toISOString(), '2026-04-16T10:30:00.000Z');
});

test('parseRelativeDuration: 1d adds 1 day', () => {
  const result = parseRelativeDuration('1d', BASE);
  assert.equal(result?.toISOString(), '2026-04-17T10:00:00.000Z');
});

test('parseRelativeDuration: 1w adds 1 week', () => {
  const result = parseRelativeDuration('1w', BASE);
  assert.equal(result?.toISOString(), '2026-04-23T10:00:00.000Z');
});

test('parseRelativeDuration: invalid garbage returns null', () => {
  assert.equal(parseRelativeDuration('abc', BASE), null);
});

test('parseRelativeDuration: empty string returns null', () => {
  assert.equal(parseRelativeDuration('', BASE), null);
});

test('parseRelativeDuration: negative returns null', () => {
  assert.equal(parseRelativeDuration('-1h', BASE), null);
});

test('parseRelativeDuration: unknown unit returns null', () => {
  assert.equal(parseRelativeDuration('1x', BASE), null);
});

test('parseRelativeDuration: zero rejected', () => {
  assert.equal(parseRelativeDuration('0h', BASE), null);
});

test('parseRelativeDuration: uppercase unit ok', () => {
  const result = parseRelativeDuration('2H', BASE);
  assert.equal(result?.toISOString(), '2026-04-16T12:00:00.000Z');
});

test('parseRelativeDuration: whitespace around and inside allowed', () => {
  const result = parseRelativeDuration('  2 h  ', BASE);
  assert.equal(result?.toISOString(), '2026-04-16T12:00:00.000Z');
});

test('parseRelativeDuration: large number works', () => {
  const result = parseRelativeDuration('48h', BASE);
  assert.equal(result?.toISOString(), '2026-04-18T10:00:00.000Z');
});

// ---- parseAbsoluteTime ------------------------------------------------

// Base: 2026-04-16 10:00 UTC = 2026-04-16 10:00 in UTC timezone.
// For tests we use tz='UTC' so "today" and "tomorrow" don't drift by offset.

test('parseAbsoluteTime: later time today (HH:MM)', () => {
  const result = parseAbsoluteTime('15:00', 'UTC', BASE);
  assert.equal(result?.toISOString(), '2026-04-16T15:00:00.000Z');
});

test('parseAbsoluteTime: earlier time rolls to tomorrow', () => {
  const result = parseAbsoluteTime('05:00', 'UTC', BASE);
  assert.equal(result?.toISOString(), '2026-04-17T05:00:00.000Z');
});

test('parseAbsoluteTime: bare hour', () => {
  const result = parseAbsoluteTime('17', 'UTC', BASE);
  assert.equal(result?.toISOString(), '2026-04-16T17:00:00.000Z');
});

test('parseAbsoluteTime: tomorrow keyword', () => {
  const result = parseAbsoluteTime('tomorrow 9', 'UTC', BASE);
  assert.equal(result?.toISOString(), '2026-04-17T09:00:00.000Z');
});

test('parseAbsoluteTime: завтра keyword', () => {
  const result = parseAbsoluteTime('завтра 18:30', 'UTC', BASE);
  assert.equal(result?.toISOString(), '2026-04-17T18:30:00.000Z');
});

test('parseAbsoluteTime: weekday alias (monday)', () => {
  // BASE is Thursday 2026-04-16 — Monday is 4 days later
  const result = parseAbsoluteTime('monday', 'UTC', BASE);
  assert.equal(result?.toISOString(), '2026-04-20T12:00:00.000Z');
});

test('parseAbsoluteTime: russian weekday with hour', () => {
  const result = parseAbsoluteTime('пятница 18:00', 'UTC', BASE);
  // Friday 2026-04-17 at 18:00 UTC
  assert.equal(result?.toISOString(), '2026-04-17T18:00:00.000Z');
});

test('parseAbsoluteTime: invalid hour', () => {
  assert.equal(parseAbsoluteTime('25:00', 'UTC', BASE), null);
});

test('parseAbsoluteTime: garbage returns null', () => {
  assert.equal(parseAbsoluteTime('banana', 'UTC', BASE), null);
});

// ---- parseWhen (combined) ---------------------------------------------

test('parseWhen: prefers relative duration', () => {
  const result = parseWhen('2h', BASE, 'UTC');
  assert.equal(result?.toISOString(), '2026-04-16T12:00:00.000Z');
});

test('parseWhen: falls back to absolute', () => {
  const result = parseWhen('17:00', BASE, 'UTC');
  assert.equal(result?.toISOString(), '2026-04-16T17:00:00.000Z');
});

test('parseWhen: invalid → null', () => {
  assert.equal(parseWhen('whatever', BASE, 'UTC'), null);
});
