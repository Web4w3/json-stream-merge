import { Readable } from 'stream';
import { createReadStream, promises as fsp } from 'fs';
import { JsonObjectExtractor } from './JsonObjectExtractor.js';
import { JsonObjectIndexer } from './JsonObjectIndexer.js';

/**
 * Merge N readable streams of JSON objects into one.
 * Keys from later streams override keys from earlier streams (last-writer-wins).
 * Each input stream must contain exactly one JSON object at the top level.
 *
 * NOTE: This buffers all unique key→rawValue pairs in memory. For arbitrary
 * streams (non-seekable), there is no way to avoid this. For file paths, use
 * mergeFiles() which uses a two-phase cursor strategy with O(index) memory.
 *
 * @param {import('stream').Readable[]} streams - ordered lowest→highest priority
 * @param {object}  [options]
 * @param {number}  [options.maxMemoryBytes=50_000_000] - raw JSON bytes cap; throws RangeError if exceeded
 * @returns {Promise<import('stream').Readable>} stream of the merged JSON object
 */
export async function mergeStreams(streams, options = {}) {
  const { maxMemoryBytes = 50_000_000 } = options;
  const result = new Map(); // key → rawValue string
  let totalBytes = 0;

  for (const stream of streams) {
    const extractor = new JsonObjectExtractor();
    for await (const chunk of stream) {
      const pairs = extractor.write(chunk);
      for (const { key, rawValue } of pairs) {
        if (result.has(key)) totalBytes -= result.get(key).length;
        totalBytes += rawValue.length;
        if (totalBytes > maxMemoryBytes) {
          throw new RangeError(
            `Memory budget exceeded: ${totalBytes} bytes > limit ${maxMemoryBytes} bytes. ` +
            'Increase options.maxMemoryBytes or reduce input size.'
          );
        }
        result.set(key, rawValue);
      }
    }
  }

  return Readable.from(_serializeObject(result));
}

/**
 * Merge JSON object files using a two-phase cursor strategy.
 *
 * Phase 1 — Index: scan every file once with JsonObjectIndexer to record
 *   { key, fileIndex, start, end } byte spans. No values are buffered.
 *   Memory cost: O(total unique keys × avg key length).
 *
 * Phase 2 — Output: for each key, open the winning file and pread just the
 *   value bytes at the recorded offset. Values are never held in memory
 *   simultaneously — each is streamed to output then released.
 *   Memory cost: O(1) working buffer per read.
 *
 * This keeps peak memory proportional to the key index, not the value data,
 * regardless of how large the input files are.
 *
 * @param {string[]} filePaths - ordered lowest→highest priority
 * @param {object}   [options]
 * @param {number}   [options.readBufferBytes=65536] - pread buffer size
 * @returns {Promise<import('stream').Readable>}
 */
export async function mergeFiles(filePaths, options = {}) {
  const { readBufferBytes = 65_536 } = options;

  // ── Phase 1: build key → { fileIndex, start, end } index ──────────────────
  // Map preserves insertion order so the first-seen key order is maintained.
  const index = new Map(); // key → { fileIndex, start, end }

  for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
    const indexer = new JsonObjectIndexer();
    const stream = createReadStream(filePaths[fileIndex]);
    for await (const chunk of stream) {
      for (const entry of indexer.write(chunk)) {
        index.set(entry.key, { fileIndex, start: entry.start, end: entry.end });
      }
    }
  }

  // ── Phase 2: stream output via pread ──────────────────────────────────────
  return Readable.from(_streamFromIndex(index, filePaths, readBufferBytes));
}

async function* _streamFromIndex(index, filePaths, readBufferBytes) {
  const handles = await Promise.all(filePaths.map(p => fsp.open(p, 'r')));
  const buf = Buffer.allocUnsafe(readBufferBytes);

  try {
    let first = true;
    yield '{';

    for (const [key, { fileIndex, start, end }] of index) {
      const byteCount = end - start;
      let valueBytes;

      if (byteCount <= readBufferBytes) {
        // Fits in reusable buffer — zero extra allocation
        await handles[fileIndex].read(buf, 0, byteCount, start);
        valueBytes = buf.toString('utf8', 0, byteCount);
      } else {
        // Value larger than buffer — allocate exactly what we need
        const large = Buffer.allocUnsafe(byteCount);
        await handles[fileIndex].read(large, 0, byteCount, start);
        valueBytes = large.toString('utf8');
      }

      yield (first ? '' : ',') + JSON.stringify(key) + ':' + valueBytes;
      first = false;
    }

    yield '}';
  } finally {
    await Promise.all(handles.map(h => h.close()));
  }
}

async function* _serializeObject(map) {
  let first = true;
  yield '{';
  for (const [key, rawValue] of map) {
    yield (first ? '' : ',') + JSON.stringify(key) + ':' + rawValue;
    first = false;
  }
  yield '}';
}
