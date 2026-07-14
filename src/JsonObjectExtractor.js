/**
 * Extracts top-level key/rawValue string pairs from a streaming JSON object.
 * Feed chunks via write(chunk) → returns completed {key, rawValue}[] pairs.
 * rawValue is the exact JSON text of the value (unparsed).
 */

const PH = { BEFORE_OPEN: 0, BETWEEN: 1, KEY: 2, COLON: 3, VALUE: 4, DONE: 5 };

export class JsonObjectExtractor {
  constructor() {
    this._ph = PH.BEFORE_OPEN;
    this._keyBuf = '';
    this._keyEsc = false;
    this._key = null;
    this._raw = '';        // accumulates raw value text across chunks
    this._depth = 0;       // nesting depth inside a container value
    this._inStr = false;   // inside a string within a value
    this._esc = false;     // next char is escaped
    this._started = false; // past leading whitespace for current value
  }

  /** @returns {{ key: string, rawValue: string }[]} */
  write(chunk) {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out = [];

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const ws = c === ' ' || c === '\t' || c === '\r' || c === '\n';

      switch (this._ph) {
        case PH.BEFORE_OPEN:
          if (ws) break;
          if (c !== '{') throw new SyntaxError(`Expected '{', got '${c}'`);
          this._ph = PH.BETWEEN;
          break;

        case PH.BETWEEN:
          if (ws || c === ',') break;
          if (c === '}') { this._ph = PH.DONE; return out; }
          if (c !== '"') throw new SyntaxError(`Expected '"' or '}', got '${c}'`);
          this._ph = PH.KEY;
          this._keyBuf = '';
          this._keyEsc = false;
          break;

        case PH.KEY:
          if (this._keyEsc) {
            this._keyBuf += '\\' + c;
            this._keyEsc = false;
          } else if (c === '\\') {
            this._keyEsc = true;
          } else if (c === '"') {
            this._key = JSON.parse('"' + this._keyBuf + '"');
            this._ph = PH.COLON;
          } else {
            this._keyBuf += c;
          }
          break;

        case PH.COLON:
          if (ws) break;
          if (c !== ':') throw new SyntaxError(`Expected ':', got '${c}'`);
          this._ph = PH.VALUE;
          this._raw = '';
          this._depth = 0;
          this._inStr = false;
          this._esc = false;
          this._started = false;
          break;

        case PH.VALUE: {
          if (!this._started) {
            if (ws) break;
            this._started = true;
            if (c === '"') { this._inStr = true; this._raw = c; break; }
            if (c === '{' || c === '[') { this._depth = 1; this._raw = c; break; }
            this._raw = c; // scalar first char
            break;
          }

          if (this._inStr) {
            this._raw += c;
            if (this._esc) { this._esc = false; break; }
            if (c === '\\') { this._esc = true; break; }
            if (c === '"') {
              this._inStr = false;
              if (this._depth === 0) {
                out.push({ key: this._key, rawValue: this._raw });
                this._resetValue();
              }
            }
            break;
          }

          if (this._depth > 0) {
            this._raw += c;
            if (c === '"') { this._inStr = true; break; }
            if (c === '{' || c === '[') { this._depth++; break; }
            if (c === '}' || c === ']') {
              this._depth--;
              if (this._depth === 0) {
                out.push({ key: this._key, rawValue: this._raw });
                this._resetValue();
              }
            }
            break;
          }

          // scalar continuation: depth === 0, not in string
          if (c === ',' || c === '}' || c === ']' || ws) {
            out.push({ key: this._key, rawValue: this._raw });
            this._resetValue();
            if (c === '}') { this._ph = PH.DONE; return out; }
            // c is ',' or whitespace — BETWEEN will handle the next key
            break;
          }
          this._raw += c;
          break;
        }

        case PH.DONE:
          return out;
      }
    }

    return out;
  }

  _resetValue() {
    this._key = null;
    this._raw = '';
    this._depth = 0;
    this._inStr = false;
    this._esc = false;
    this._started = false;
    this._ph = PH.BETWEEN;
  }

  get done() {
    return this._ph === PH.DONE;
  }
}
