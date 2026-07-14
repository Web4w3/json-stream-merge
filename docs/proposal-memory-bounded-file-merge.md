# Proposal: Memory-Bounded File Merge for `mergeFiles()`

## Status

Open — implementation pending.  
Related issue: [#1 mergeFiles() loads all values into memory](../../issues/1)

---

## Background

`json-stream-merge` exposes two merge entry points:

- `mergeStreams(streams)` — accepts `Readable` streams; suitable for piped or
  network data where the source cannot be revisited.
- `mergeFiles(filePaths)` — accepts file paths on disk; intended for large
  on-disk JSON objects that would not fit in memory as a whole.

The rationale for a separate `mergeFiles()` API is that files, unlike streams,
are randomly accessible.  A caller who passes file paths instead of streams is
explicitly signalling that the source data lives on disk and may be larger than
available V8 heap.

## Problem

The current `mergeFiles()` implementation does not exploit the random-access
property of files.  Internally it opens each file as a `ReadStream` and feeds
the bytes through `JsonObjectExtractor`, accumulating every key-value pair into
a `Map<string, string>` (key → raw JSON text of the value) before writing any
output.

This means that for N files whose combined unique values total V bytes, the
function holds V bytes of JSON strings on the V8 heap simultaneously.  A set
of input files totalling 10 GB of values requires approximately 10 GB of V8
heap — identical to simply calling `JSON.parse` on each file.

The `mergeFiles()` API therefore provides no memory advantage over
`mergeStreams()` despite having access to seekable file descriptors.

## Requirements for a Solution

Any acceptable solution must satisfy all of the following constraints.

### Functional correctness

1. The merged output must be a valid JSON object containing every key that
   appears across all input files.
2. When the same key appears in multiple files, the value from the
   **last file in the array** (highest index) must win.
3. The key order in the output must be deterministic across repeated calls with
   the same inputs.
4. All JSON value types must survive the merge: strings (including non-ASCII
   and escape sequences), numbers, booleans, `null`, arrays, and nested
   objects.

### Memory behaviour

5. Peak V8 heap usage must be **sub-linear in the total size of value data**.
   Holding all values simultaneously, even temporarily, is not acceptable.
6. Reading the same byte range of an input file more than once is allowed if
   doing so avoids buffering values.
7. Large values (values whose byte length exceeds available contiguous heap)
   must not cause an OOM error; the function must be able to produce them in
   the output without materialising them fully in V8 memory at once, or
   alternatively must stream them directly from the file handle.

### API compatibility

8. The public signature `mergeFiles(filePaths, options?)` must not change.
9. The returned value must remain a `Promise<Readable>` whose chunks join into
   valid JSON.
10. Existing options (`maxMemoryBytes` or similar) may be repurposed or removed
    if they no longer apply, but the change must be documented.

### Observability

11. The implementation must produce a result that is testable: given files of
    known content it must be possible to assert that the peak number of value
    bytes held in memory at any instant is bounded regardless of input size.

---

## Out of Scope

- Changes to `mergeStreams()`.  Streams are not seekable; their current
  buffering approach is unavoidable.
- Support for non-object top-level values (arrays, primitives).  Both the
  existing implementation and this proposal target top-level JSON objects only.
- Compression, encryption, or other file transformations.

---

## Open Questions

- Should the solution expose `JsonObjectIndexer` (or an equivalent span index
  type) as a public export so consumers can build their own two-pass tooling on
  top of it?
- What is an appropriate default for the internal read-buffer size, and should
  it be tunable via `options`?
- Should the function support a streaming input for the file list itself (e.g.
  `AsyncIterable<string>`) or remain synchronous-array only?
