/**
 * Like JsonObjectExtractor but records absolute byte positions of values
 * instead of accumulating their text. Used for the two-phase file merge.
 *
 * write(Buffer) → { key: string, start: number, end: number }[]
 * where [start, end) are byte offsets in the source file.
 */

const PH = { BEFORE_OPEN: 0, BETWEEN: 1, KEY: 2, COLON: 3, VALUE: 4, DONE: 5 };

// ASCII byte constants for readability
const B = {
  SPACE: 32, TAB: 9, CR: 13, LF: 10,
  DQUOTE: 0x22, COMMA: 0x2C,
  LBRACE: 0x7B, RBRACE: 0x7D,
  LBRACK: 0x5B, RBRACK: 0x5D,
  COLON: 0x3A, BACKSLASH: 0x5C,
};

export class JsonObjectIndexer {
  constructor() {
    this._ph = PH.BEFORE_OPEN;
    this._keyBytes = [];   // raw bytes of current key including escape sequences
    this._keyEsc = false;
    this._key = null;
    this._absPos = 0;      // running absolute byte offset in the source file
    this._valStart = -1;   // absolute byte offset where current value starts
    this._depth = 0;
    this._inStr = false;
    this._esc = false;
    this._started = false;
  }

  /** @param {Buffer|string} chunk @returns {{ key: string, start: number, end: number }[]} */
  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    const out = [];

    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      const abs = this._absPos + i;
      const ws = b === B.SPACE || b === B.TAB || b === B.CR || b === B.LF;

      switch (this._ph) {
        case PH.BEFORE_OPEN:
          if (ws) break;
          if (b !== B.LBRACE) throw new SyntaxError(`Expected '{', got byte 0x${b.toString(16)}`);
          this._ph = PH.BETWEEN;
          break;

        case PH.BETWEEN:
          if (ws || b === B.COMMA) break;
          if (b === B.RBRACE) { this._ph = PH.DONE; this._absPos += buf.length; return out; }
          if (b !== B.DQUOTE) throw new SyntaxError(`Expected '"', got byte 0x${b.toString(16)}`);
          this._ph = PH.KEY;
          this._keyBytes = [];
          this._keyEsc = false;
          break;

        case PH.KEY:
          if (this._keyEsc) {
            this._keyBytes.push(B.BACKSLASH, b); // keep raw escape for JSON.parse unescaping
            this._keyEsc = false;
          } else if (b === B.BACKSLASH) {
            this._keyEsc = true;
          } else if (b === B.DQUOTE) {
            const raw = Buffer.from(this._keyBytes).toString('utf8');
            this._key = JSON.parse('"' + raw + '"');
            this._ph = PH.COLON;
          } else {
            this._keyBytes.push(b);
          }
          break;

        case PH.COLON:
          if (ws) break;
          if (b !== B.COLON) throw new SyntaxError(`Expected ':', got byte 0x${b.toString(16)}`);
          this._ph = PH.VALUE;
          this._valStart = -1;
          this._depth = 0;
          this._inStr = false;
          this._esc = false;
          this._started = false;
          break;

        case PH.VALUE: {
          if (!this._started) {
            if (ws) break;
            this._started = true;
            this._valStart = abs;
            if (b === B.DQUOTE) { this._inStr = true; break; }
            if (b === B.LBRACE || b === B.LBRACK) { this._depth = 1; break; }
            // scalar: first byte recorded via _valStart above
            break;
          }

          if (this._inStr) {
            if (this._esc) { this._esc = false; break; }
            if (b === B.BACKSLASH) { this._esc = true; break; }
            if (b === B.DQUOTE) {
              this._inStr = false;
              if (this._depth === 0) {
                out.push({ key: this._key, start: this._valStart, end: abs + 1 });
                this._resetValue();
              }
            }
            break;
          }

          if (this._depth > 0) {
            if (b === B.DQUOTE) { this._inStr = true; break; }
            if (b === B.LBRACE || b === B.LBRACK) { this._depth++; break; }
            if (b === B.RBRACE || b === B.RBRACK) {
              if (--this._depth === 0) {
                out.push({ key: this._key, start: this._valStart, end: abs + 1 });
                this._resetValue();
              }
            }
            break;
          }

          // scalar continuation: depth === 0, not in string
          if (b === B.COMMA || b === B.RBRACE || b === B.RBRACK || ws) {
            out.push({ key: this._key, start: this._valStart, end: abs });
            this._resetValue();
            if (b === B.RBRACE) { this._ph = PH.DONE; this._absPos += buf.length; return out; }
            break;
          }
          break;
        }

        case PH.DONE:
          this._absPos += buf.length;
          return out;
      }
    }

    this._absPos += buf.length;
    return out;
  }

  _resetValue() {
    this._key = null;
    this._valStart = -1;
    this._depth = 0;
    this._inStr = false;
    this._esc = false;
    this._started = false;
    this._ph = PH.BETWEEN;
  }

  get done() { return this._ph === PH.DONE; }
}
