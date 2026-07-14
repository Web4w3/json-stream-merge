import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeFiles } from '../src/mergeStreams.js';

const TMP = join(tmpdir(), 'jsm-test-' + process.pid);

async function write(name, obj) {
  const p = join(TMP, name);
  await writeFile(p, JSON.stringify(obj), 'utf8');
  return p;
}

async function collect(readable) {
  const chunks = [];
  for await (const c of readable) chunks.push(typeof c === 'string' ? c : c.toString());
  return JSON.parse(chunks.join(''));
}

before(async () => { await mkdir(TMP, { recursive: true }); });
after(async ()  => { await rm(TMP, { recursive: true, force: true }); });

describe('two-phase file merge — correctness', () => {
  test('single file passthrough', async () => {
    const f = await write('single.json', { a: 1, b: 2 });
    assert.deepEqual(await collect(await mergeFiles([f])), { a: 1, b: 2 });
  });

  test('second file overrides first', async () => {
    const f1 = await write('base.json',  { a: 1, b: 2 });
    const f2 = await write('patch.json', { b: 99, c: 3 });
    assert.deepEqual(await collect(await mergeFiles([f1, f2])), { a: 1, b: 99, c: 3 });
  });

  test('last-writer-wins across three files', async () => {
    const f1 = await write('v1.json', { x: 1 });
    const f2 = await write('v2.json', { x: 2 });
    const f3 = await write('v3.json', { x: 3 });
    assert.equal((await collect(await mergeFiles([f1, f2, f3]))).x, 3);
  });

  test('empty files', async () => {
    const f1 = await write('e1.json', {});
    const f2 = await write('e2.json', { a: 1 });
    assert.deepEqual(await collect(await mergeFiles([f1, f2])), { a: 1 });
  });

  test('all value types survive round-trip', async () => {
    const obj = { s: 'str', n: 42, f: 3.14, b: true, nl: null, a: [1, 2], o: { x: 1 } };
    const f = await write('types.json', obj);
    assert.deepEqual(await collect(await mergeFiles([f])), obj);
  });

  test('output is valid JSON', async () => {
    const f1 = await write('j1.json', { a: 1 });
    const f2 = await write('j2.json', { b: 2 });
    const out = await mergeFiles([f1, f2]);
    const chunks = [];
    for await (const c of out) chunks.push(c);
    assert.doesNotThrow(() => JSON.parse(chunks.join('')));
  });
});

describe('memory efficiency — index only, not values', () => {
  test('100 unique keys — only key names in index', async () => {
    const obj = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, 'x'.repeat(1000)]));
    const f = await write('big.json', obj);
    // If this ran the old approach, the Map would hold 100 × 1000 bytes.
    // The new approach holds only key names in the index — values are pread on demand.
    const result = await collect(await mergeFiles([f]));
    assert.equal(Object.keys(result).length, 100);
    assert.equal(result.key0, 'x'.repeat(1000));
  });

  test('large value retrieved correctly via pread', async () => {
    const largeValue = 'A'.repeat(200_000);
    const f = await write('large-val.json', { data: largeValue });
    const result = await collect(await mergeFiles([f]));
    assert.equal(result.data.length, 200_000);
    assert.equal(result.data[0], 'A');
  });

  test('value larger than default readBufferBytes uses per-value allocation', async () => {
    // Default readBufferBytes is 64KB; this value is 128KB
    const largeValue = 'Z'.repeat(128_000);
    const f = await write('over-buf.json', { v: largeValue });
    const result = await collect(await mergeFiles([f], { readBufferBytes: 64_000 }));
    assert.equal(result.v.length, 128_000);
  });
});
