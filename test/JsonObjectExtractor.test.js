import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JsonObjectExtractor } from '../src/JsonObjectExtractor.js';

function extract(json) {
  return new JsonObjectExtractor().write(json);
}

function extractChunked(json, size) {
  const ex = new JsonObjectExtractor();
  const out = [];
  for (let i = 0; i < json.length; i += size) out.push(...ex.write(json.slice(i, i + size)));
  return out;
}

describe('empty / trivial', () => {
  test('empty object', () => assert.deepEqual(extract('{}'), []));
  test('empty object with whitespace', () => assert.deepEqual(extract(' { } '), []));
});

describe('scalar values', () => {
  test('integer', () => assert.equal(extract('{"n":42}')[0].rawValue, '42'));
  test('negative float', () => assert.equal(extract('{"n":-3.14}')[0].rawValue, '-3.14'));
  test('scientific notation', () => assert.equal(extract('{"n":1.5e10}')[0].rawValue, '1.5e10'));
  test('true', () => assert.equal(extract('{"b":true}')[0].rawValue, 'true'));
  test('false', () => assert.equal(extract('{"b":false}')[0].rawValue, 'false'));
  test('null', () => assert.equal(extract('{"v":null}')[0].rawValue, 'null'));
});

describe('string values', () => {
  test('simple string', () => assert.equal(extract('{"s":"hello"}')[0].rawValue, '"hello"'));
  test('empty string', () => assert.equal(extract('{"s":""}')[0].rawValue, '""'));
  test('string with newline escape', () => {
    const [p] = extract('{"s":"a\\nb"}');
    assert.equal(JSON.parse(p.rawValue), 'a\nb');
  });
  test('string with escaped quote', () => {
    const [p] = extract('{"s":"say \\"hi\\""}');
    assert.equal(JSON.parse(p.rawValue), 'say "hi"');
  });
  test('string with unicode escape', () => {
    const [p] = extract('{"s":"\\u0041"}');
    assert.equal(JSON.parse(p.rawValue), 'A');
  });
});

describe('container values', () => {
  test('nested object', () => {
    const [p] = extract('{"o":{"a":1,"b":2}}');
    assert.deepEqual(JSON.parse(p.rawValue), { a: 1, b: 2 });
  });
  test('empty nested object', () => assert.equal(extract('{"o":{}}')[0].rawValue, '{}'));
  test('array value', () => {
    const [p] = extract('{"a":[1,2,3]}');
    assert.deepEqual(JSON.parse(p.rawValue), [1, 2, 3]);
  });
  test('empty array', () => assert.equal(extract('{"a":[]}')[0].rawValue, '[]'));
  test('nested array of objects', () => {
    const [p] = extract('{"d":[{"id":1},{"id":2}]}');
    assert.deepEqual(JSON.parse(p.rawValue), [{ id: 1 }, { id: 2 }]);
  });
  test('deeply nested', () => {
    const deep = '{"x":' + '['.repeat(10) + '1' + ']'.repeat(10) + '}';
    const [p] = extract(deep);
    assert.equal(p.rawValue, '['.repeat(10) + '1' + ']'.repeat(10));
  });
});

describe('multiple pairs', () => {
  test('three pairs', () => {
    const pairs = extract('{"a":1,"b":"two","c":true}');
    assert.equal(pairs.length, 3);
    assert.equal(pairs[0].key, 'a');
    assert.equal(pairs[1].key, 'b');
    assert.equal(pairs[2].key, 'c');
  });
  test('preserves insertion order', () => {
    const keys = extract('{"z":1,"a":2,"m":3}').map(p => p.key);
    assert.deepEqual(keys, ['z', 'a', 'm']);
  });
  test('whitespace around colons and commas', () => {
    const pairs = extract(' { "a" : 1 , "b" : 2 } ');
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].rawValue, '1');
    assert.equal(pairs[1].rawValue, '2');
  });
});

describe('key handling', () => {
  test('key with unicode escape', () => {
    const [p] = extract('{"\\u006bey":"val"}');
    assert.equal(p.key, 'key');
  });
  test('key with backslash escape', () => {
    const [p] = extract('{"a\\/b":"val"}');
    assert.equal(p.key, 'a/b');
  });
});

describe('chunked input', () => {
  test('value split across chunks', () => {
    const pairs = extractChunked('{"name":"Alice","age":30}', 5);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].rawValue, '"Alice"');
    assert.equal(pairs[1].rawValue, '30');
  });
  test('single-char chunks', () => {
    const pairs = extractChunked('{"a":{"b":{"c":42}}}', 1);
    assert.equal(pairs.length, 1);
    assert.deepEqual(JSON.parse(pairs[0].rawValue), { b: { c: 42 } });
  });
  test('chunk boundary inside escape sequence', () => {
    const pairs = extractChunked('{"s":"\\n"}', 4);
    assert.equal(JSON.parse(pairs[0].rawValue), '\n');
  });
});

describe('done flag', () => {
  test('set after closing brace', () => {
    const ex = new JsonObjectExtractor();
    ex.write('{"a":1}');
    assert.equal(ex.done, true);
  });
  test('false mid-stream', () => {
    const ex = new JsonObjectExtractor();
    ex.write('{"a":1');
    assert.equal(ex.done, false);
  });
});

describe('error cases', () => {
  test('throws on non-object input', () => {
    assert.throws(() => extract('[1,2,3]'), SyntaxError);
  });
  test('throws on missing colon', () => {
    assert.throws(() => extract('{"a" 1}'), SyntaxError);
  });
});
