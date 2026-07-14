import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { mergeStreams } from '../src/mergeStreams.js';

function fromStr(s) {
  return Readable.from([s]);
}

async function collect(readable) {
  const chunks = [];
  for await (const c of readable) chunks.push(typeof c === 'string' ? c : c.toString());
  return JSON.parse(chunks.join(''));
}

describe('basic merging', () => {
  test('single stream passthrough', async () => {
    const out = await mergeStreams([fromStr('{"a":1,"b":2}')]);
    assert.deepEqual(await collect(out), { a: 1, b: 2 });
  });

  test('second stream overrides first on conflict', async () => {
    const out = await mergeStreams([fromStr('{"a":1,"b":2}'), fromStr('{"b":99,"c":3}')]);
    assert.deepEqual(await collect(out), { a: 1, b: 99, c: 3 });
  });

  test('last-writer-wins across three streams', async () => {
    const out = await mergeStreams([fromStr('{"x":1}'), fromStr('{"x":2}'), fromStr('{"x":3}')]);
    assert.equal((await collect(out)).x, 3);
  });

  test('all unique keys are preserved', async () => {
    const out = await mergeStreams([fromStr('{"a":1,"b":2}'), fromStr('{"c":3,"d":4}')]);
    assert.deepEqual(await collect(out), { a: 1, b: 2, c: 3, d: 4 });
  });
});

describe('edge cases', () => {
  test('empty second stream', async () => {
    const out = await mergeStreams([fromStr('{"a":1}'), fromStr('{}')]);
    assert.deepEqual(await collect(out), { a: 1 });
  });

  test('both streams empty', async () => {
    const out = await mergeStreams([fromStr('{}'), fromStr('{}')]);
    assert.deepEqual(await collect(out), {});
  });

  test('single empty stream', async () => {
    const out = await mergeStreams([fromStr('{}')]);
    assert.deepEqual(await collect(out), {});
  });

  test('first stream empty, second has data', async () => {
    const out = await mergeStreams([fromStr('{}'), fromStr('{"a":1}')]);
    assert.deepEqual(await collect(out), { a: 1 });
  });
});

describe('value types', () => {
  test('all JSON value types', async () => {
    const input = '{"s":"str","n":42,"f":3.14,"b":true,"nl":null,"a":[1,2],"o":{"x":1}}';
    const out = await mergeStreams([fromStr(input)]);
    assert.deepEqual(await collect(out), {
      s: 'str', n: 42, f: 3.14, b: true, nl: null, a: [1, 2], o: { x: 1 },
    });
  });

  test('nested objects replaced entirely (not deep-merged)', async () => {
    const out = await mergeStreams([
      fromStr('{"cfg":{"debug":true,"timeout":30}}'),
      fromStr('{"cfg":{"debug":false}}'),
    ]);
    assert.deepEqual((await collect(out)).cfg, { debug: false });
  });
});

describe('scale', () => {
  test('100 unique keys across two streams', async () => {
    const obj1 = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const obj2 = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i + 50}`, i + 50]));
    const out = await mergeStreams([fromStr(JSON.stringify(obj1)), fromStr(JSON.stringify(obj2))]);
    const merged = await collect(out);
    assert.equal(Object.keys(merged).length, 100);
    assert.equal(merged.k0, 0);
    assert.equal(merged.k99, 99);
  });
});

describe('memory budget', () => {
  test('throws RangeError when budget exceeded', async () => {
    const big = '{"data":"' + 'x'.repeat(10_000) + '"}';
    await assert.rejects(
      () => mergeStreams([fromStr(big)], { maxMemoryBytes: 100 }),
      RangeError
    );
  });

  test('does not throw when within budget', async () => {
    const small = '{"a":1,"b":2}';
    const out = await mergeStreams([fromStr(small)], { maxMemoryBytes: 1_000 });
    assert.ok(out);
  });
});

describe('output validity', () => {
  test('output is always valid JSON', async () => {
    const out = await mergeStreams([fromStr('{"a":1}'), fromStr('{"b":2}')]);
    const chunks = [];
    for await (const c of out) chunks.push(c);
    assert.doesNotThrow(() => JSON.parse(chunks.join('')));
  });

  test('keys with special chars are correctly serialized', async () => {
    const out = await mergeStreams([fromStr('{"a\\"b":1}')]);
    const obj = await collect(out);
    assert.equal(obj['a"b'], 1);
  });
});
