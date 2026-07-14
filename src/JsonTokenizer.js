/**
 * Incremental JSON tokenizer that operates on Buffer chunks.
 * Emits tokens: { type, value } where type is one of:
 *   'object-start', 'object-end', 'array-start', 'array-end',
 *   'key', 'string', 'number', 'boolean', 'null'
 */

const State = {
  VALUE: 0,
  STRING: 1,
  STRING_ESCAPE: 2,
  STRING_UNICODE: 3,
  NUMBER: 4,
  LITERAL: 5,
  KEY: 6,
  KEY_ESCAPE: 7,
  KEY_UNICODE: 8,
  COLON: 9,
  COMMA_OR_END: 10,
};

export class JsonTokenizer {
  constructor() {
    this._state = State.VALUE;
    this._stack = [];   // 'object' | 'array'
    this._buf = '';
    this._unicode = '';
    this._tokens = [];
    this._expectKey = false;
  }

  /** Feed a string or Buffer chunk; returns array of emitted tokens. */
  write(chunk) {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this._tokens = [];
    for (let i = 0; i < s.length; i++) {
      this._feed(s[i], s.charCodeAt(i));
    }
    return this._tokens;
  }

  _emit(type, value) {
    this._tokens.push({ type, value });
  }

  _feed(ch, code) {
    switch (this._state) {
      case State.VALUE:
      case State.COLON: {
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break;
        if (this._state === State.COLON) {
          if (ch === ':') { this._state = State.VALUE; break; }
          throw new SyntaxError(`Expected ':' got '${ch}'`);
        }
        if (ch === '{') {
          this._emit('object-start');
          this._stack.push('object');
          this._expectKey = true;
          this._state = State.COMMA_OR_END;
          break;
        }
        if (ch === '[') {
          this._emit('array-start');
          this._stack.push('array');
          this._expectKey = false;
          this._state = State.COMMA_OR_END;
          break;
        }
        if (ch === '"') {
          this._buf = '';
          this._state = State.STRING;
          break;
        }
        if (ch === '-' || (code >= 48 && code <= 57)) {
          this._buf = ch;
          this._state = State.NUMBER;
          break;
        }
        if (ch === 't' || ch === 'f' || ch === 'n') {
          this._buf = ch;
          this._state = State.LITERAL;
          break;
        }
        throw new SyntaxError(`Unexpected token '${ch}'`);
      }

      case State.COMMA_OR_END: {
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break;
        const top = this._stack[this._stack.length - 1];
        if (ch === '}' && top === 'object') {
          this._stack.pop();
          this._emit('object-end');
          this._afterValue();
          break;
        }
        if (ch === ']' && top === 'array') {
          this._stack.pop();
          this._emit('array-end');
          this._afterValue();
          break;
        }
        if (ch === ',') {
          if (top === 'object') {
            this._expectKey = true;
            this._state = State.KEY;
            // skip whitespace before key string
          } else {
            this._state = State.VALUE;
          }
          break;
        }
        // First value in container (no leading comma)
        if (top === 'object' && this._expectKey) {
          if (ch === '"') { this._buf = ''; this._state = State.KEY; break; }
          throw new SyntaxError(`Expected key string, got '${ch}'`);
        }
        // First value in array
        this._state = State.VALUE;
        this._feed(ch, code);
        break;
      }

      case State.KEY: {
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break;
        if (ch === '"') { this._buf = ''; this._state = State.KEY; break; }
        // Already in key string reading — shouldn't normally reach here unless we
        // re-entered; fall through to STRING logic below
        this._buf = '';
        this._state = State.KEY;
        break;
      }

      case State.STRING:
      case State.KEY: {
        // Handled above; deduplicated below
        if (ch === '\\') {
          this._state = this._state === State.STRING ? State.STRING_ESCAPE : State.KEY_ESCAPE;
          break;
        }
        if (ch === '"') {
          const val = this._buf;
          this._buf = '';
          if (this._state === State.KEY) {
            this._emit('key', val);
            this._state = State.COLON;
          } else {
            this._emit('string', val);
            this._afterValue();
          }
          break;
        }
        this._buf += ch;
        break;
      }

      case State.STRING_ESCAPE:
      case State.KEY_ESCAPE: {
        const isKey = this._state === State.KEY_ESCAPE;
        const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (ch in ESC) {
          this._buf += ESC[ch];
          this._state = isKey ? State.KEY : State.STRING;
        } else if (ch === 'u') {
          this._unicode = '';
          this._state = isKey ? State.KEY_UNICODE : State.STRING_UNICODE;
        } else {
          throw new SyntaxError(`Invalid escape \\${ch}`);
        }
        break;
      }

      case State.STRING_UNICODE:
      case State.KEY_UNICODE: {
        this._unicode += ch;
        if (this._unicode.length === 4) {
          this._buf += String.fromCharCode(parseInt(this._unicode, 16));
          this._unicode = '';
          this._state = this._state === State.KEY_UNICODE ? State.KEY : State.STRING;
        }
        break;
      }

      case State.NUMBER: {
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' ||
            ch === ',' || ch === '}' || ch === ']') {
          this._emit('number', JSON.parse(this._buf));
          this._buf = '';
          this._afterValue();
          this._feed(ch, code);
        } else {
          this._buf += ch;
        }
        break;
      }

      case State.LITERAL: {
        this._buf += ch;
        const b = this._buf;
        if (b === 'true')  { this._emit('boolean', true);  this._buf = ''; this._afterValue(); break; }
        if (b === 'false') { this._emit('boolean', false); this._buf = ''; this._afterValue(); break; }
        if (b === 'null')  { this._emit('null', null);      this._buf = ''; this._afterValue(); break; }
        if (!'true'.startsWith(b) && !'false'.startsWith(b) && !'null'.startsWith(b)) {
          throw new SyntaxError(`Invalid literal '${b}'`);
        }
        break;
      }
    }
  }

  _afterValue() {
    if (this._stack.length === 0) {
      this._state = State.VALUE;
      return;
    }
    this._expectKey = false;
    this._state = State.COMMA_OR_END;
  }
}
