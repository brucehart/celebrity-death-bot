import test from 'node:test';
import assert from 'node:assert/strict';

import { extractAndParseJSON, coalesceOutput } from '../src/utils/json.ts';

test('extractAndParseJSON handles code fences and arrays', () => {
  const text = '```json\n[{"name":"A"}]\n```';
  const parsed = extractAndParseJSON(text);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].name, 'A');
});

test('extractAndParseJSON slices object from noisy text', () => {
  const text = 'prefix {"x":1, "y":2} suffix';
  const parsed = extractAndParseJSON(text);
  assert.equal(parsed.x, 1);
  assert.equal(parsed.y, 2);
});

test('coalesceOutput flattens nested string arrays', () => {
  const raw = ['a', ['b', ['c']]];
  assert.equal(coalesceOutput(raw), 'abc');
});

