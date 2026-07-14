import { Readable } from 'stream';
import { createReadStream } from 'fs';
import { JsonObjectExtractor } from './JsonObjectExtractor.js';

/**
 * Merge N readable streams of JSON objects into one.
 * Keys from later streams override keys from earlier streams (last-writer-wins).
 * Each input stream must contain exactly one JSON object at the top level.
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
 * Convenience wrapper: merge JSON object files by path.
 * Files are processed in the order given; later files win on key conflicts.
 *
 * @param {string[]} filePaths - ordered lowest→highest priority
 * @param {object}   [options] - passed through to mergeStreams
 * @returns {Promise<import('stream').Readable>}
 */
export async function mergeFiles(filePaths, options = {}) {
  const streams = filePaths.map(p => createReadStream(p, { encoding: 'utf8' }));
  return mergeStreams(streams, options);
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
