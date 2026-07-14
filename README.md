# @web4w3/json-stream-merge

Memory-bounded N-way streaming JSON merge — merges multiple large JSON objects in a single pass without loading them fully into memory.

**Why:** `JSON.parse` must hold the entire input string + the parsed object tree in memory simultaneously (~3× file size at peak). For large files this exhausts the heap. This library parses each file chunk-by-chunk using a hand-written SAX tokenizer, keeps only raw JSON strings per key (not parsed objects), and streams the merged result — so peak memory is proportional to the number of _unique keys_, not the total file size.

## Install

```sh
npm install @web4w3/json-stream-merge
```

## Usage

```js
import { mergeStreams, mergeFiles } from '@web4w3/json-stream-merge';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

// From file paths (convenience)
const merged = await mergeFiles(['base.json', 'overrides.json']);
await pipeline(merged, createWriteStream('result.json'));

// From Readable streams
import { createReadStream } from 'fs';
const merged2 = await mergeStreams([
  createReadStream('base.json'),
  createReadStream('overrides.json'),
]);
for await (const chunk of merged2) process.stdout.write(chunk);
```

## Merge semantics

- Inputs must be JSON **objects** (`{…}`) at the top level.
- Keys from **later** streams override keys from earlier streams (last-writer-wins).
- Nested objects and arrays are replaced **entirely** — this is a shallow merge, not a deep one.
- Key order in the output follows insertion order (first seen wins for ordering, last seen wins for value).

```js
// base.json:     {"a": 1, "b": {"x": 1}}
// patch.json:    {"b": {"y": 2}, "c": 3}
// result:        {"a": 1, "b": {"y": 2}, "c": 3}
//                        ^^^^^^^^ replaced, not deep-merged
```

## API

### `mergeStreams(streams, options?) → Promise<Readable>`

| Param | Type | Description |
|---|---|---|
| `streams` | `Readable[]` | Input streams, lowest→highest priority |
| `options.maxMemoryBytes` | `number` | Raw JSON bytes cap (default: 50 MB). Throws `RangeError` if exceeded. |

Returns a `Readable` that emits UTF-8 string chunks of the merged JSON object.

### `mergeFiles(filePaths, options?) → Promise<Readable>`

Convenience wrapper that opens each path as a `ReadStream`. Same options as `mergeStreams`.

### `JsonObjectExtractor` (advanced)

Low-level SAX tokenizer. Feed it chunks and it yields `{ key, rawValue }` pairs as they complete.

```js
import { JsonObjectExtractor } from '@web4w3/json-stream-merge';

const ex = new JsonObjectExtractor();
for await (const chunk of someStream) {
  for (const { key, rawValue } of ex.write(chunk)) {
    console.log(key, rawValue); // rawValue is the verbatim JSON string
  }
}
```

## Memory model

| What | Memory cost |
|---|---|
| `JSON.parse` on a 1 GB file | ~3 GB peak (string + object tree) |
| This library, 1 GB file, 10k unique keys × avg 100 B values | ~1 MB |
| This library, worst case (all unique keys, large values) | sum of all unique values' raw JSON sizes |

The `maxMemoryBytes` option caps the second dimension (raw value storage). If your unique keys have very large values, raise the limit or pipe results to disk instead of collecting them.

## Requirements

Node.js ≥ 18. No runtime dependencies.

## License

MIT © [Web4w3 LLC](https://web4w3.com)
