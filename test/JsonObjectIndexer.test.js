import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JsonObjectIndexer } from '../src/JsonObjectIndexer.js';

function index(json) {
  const buf = Buffer.from(json, 'utf8');
  const idx = new JsonObjectIndexer();
  return { entries: idx.write(buf), buf };
}

function indexChunked(json, chunkSize) {
  const buf = Buffer.from(json, 'utf8');
  const idx = new JsonObjectIndexer();
  const entries = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    entries.push(...idx.write(buf.slice(i, i + chunkSize)));
  }
  return { entries, buf };
}

function rawOf(buf, entry) {
  return buf.slice(entry.start, entry.end).toString('utf8');
}

describe('basic position tracking', () => {
  test('integer value — correct byte span', () => {
    const { entries, buf } = index('{"n":42}');
    assert.equal(entries.length, 1);
    assert.equal(rawOf(buf, entries[0]), '42');
  });

  test('string value — includes quotes', () => {
    const { entries, buf } = index('{"s":"hello"}');
    assert.equal(rawOf(buf, entries[0]), '"hello"');
  });

  test('nested object — full span', () => {
    const { entries, buf } = index('{"o":{"a":1}}');
    assert.deepEqual(JSON.parse(rawOf(buf, entries[0])), { a: 1 });
  });

  test('multiple keys — independent spans', () => {
    const { entries, buf } = index('{"a":1,"b":"two","c":true}');
    assert.equal(rawOf(buf, entries[0]), '1');
    assert.equal(rawOf(buf, entries[1]), '"two"');
    assert.equal(rawOf(buf, entries[2]), 'true');
  });

  test('later file wins — overwrite same key', () => {
    const { entries } = index('{"x":1,"x":2}');
    // Both entries are yielded; the caller builds the index and last wins
    assert.equal(entries.length, 2);
    assert.equal(entries[0].key, 'x');
    assert.equal(entries[1].key, 'x');
  });
});

describe('byte positions are absolute across chunks', () => {
  test('single-byte chunks', () => {
    const json = '{"a":99,"b":100}';
    const { entries, buf } = indexChunked(json, 1);
    assert.equal(rawOf(buf, entries[0]), '99');
    assert.equal(rawOf(buf, entries[1]), '100');
  });

  test('value split across chunk boundary', () => {
    const json = '{"name":"Alice","age":30}';
    const { entries, buf } = indexChunked(json, 7);
    assert.equal(entries.length, 2);
    assert.equal(rawOf(buf, entries[0]), '"Alice"');
    assert.equal(rawOf(buf, entries[1]), '30');
  });

  test('positions remain valid when chunks are small', () => {
    const json = '{"v":{"deep":[1,2,3]}}';
    const { entries, buf } = indexChunked(json, 3);
    assert.deepEqual(JSON.parse(rawOf(buf, entries[0])), { deep: [1, 2, 3] });
  });
});

describe('non-ASCII keys and values', () => {
  test('non-ASCII key', () => {
    const json = '{"café":1}';
    const buf = Buffer.from(json, 'utf8');
    const idx = new JsonObjectIndexer();
    const entries = idx.write(buf);
    assert.equal(entries[0].key, 'café');
  });

  test('non-ASCII string value preserved verbatim', () => {
    const json = '{"s":"café"}';
    const buf = Buffer.from(json, 'utf8');
    const idx = new JsonObjectIndexer();
    const entries = idx.write(buf);
    const raw = buf.slice(entries[0].start, entries[0].end).toString('utf8');
    assert.equal(JSON.parse(raw), 'café');
  });
});

describe('done flag', () => {
  test('set after closing brace', () => {
    const idx = new JsonObjectIndexer();
    idx.write(Buffer.from('{"a":1}'));
    assert.equal(idx.done, true);
  });
});
