// Pure strict JSON parser retained from the reviewed decision-menu source.
const fail=message=>{throw new Error(`XUAN-IB decision menu: ${message}`);};

// Same duplicate-key-rejecting recursive descent as handover-guard.mjs; do not
// replace this with JSON.parse, which silently accepts the last duplicate key.
export function parseDecisionJson(source, maxLength = 65_536) {
  if (typeof source !== 'string' || source.length > maxLength) fail(`JSON input must be at most ${maxLength} characters`);
  let index = 0;
  const ws = () => { while (/[ \t\r\n]/.test(source[index] || '')) index++; };
  const string = () => {
    const start = index++;
    let escaped = false;
    while (index < source.length) {
      const char = source[index++];
      if (!escaped && char === '"') {
        try { return JSON.parse(source.slice(start, index)); }
        catch { throw new Error('invalid escaped JSON string'); }
      }
      if (!escaped && char.charCodeAt(0) < 32) throw new Error('control character');
      escaped = !escaped && char === '\\';
    }
    throw new Error('unterminated string');
  };
  const value = (depth = 0) => {
    if (depth > 32) throw new Error('JSON nesting exceeds limit');
    ws();
    if (source[index] === '"') return string();
    if (source[index] === '{') {
      index++; ws();
      const result = Object.create(null);
      if (source[index] === '}') { index++; return result; }
      while (index < source.length) {
        ws();
        if (source[index] !== '"') throw new Error('object key must be quoted');
        const key = string();
        if (Object.hasOwn(result, key)) throw new Error('duplicate key');
        ws();
        if (source[index++] !== ':') throw new Error('missing colon');
        result[key] = value(depth + 1); ws();
        if (source[index] === '}') { index++; return result; }
        if (source[index++] !== ',') throw new Error('missing comma');
      }
      throw new Error('unterminated object');
    }
    if (source[index] === '[') {
      index++; ws();
      const result = [];
      if (source[index] === ']') { index++; return result; }
      while (index < source.length) {
        result.push(value(depth + 1)); ws();
        if (source[index] === ']') { index++; return result; }
        if (source[index++] !== ',') throw new Error('missing comma');
      }
      throw new Error('unterminated array');
    }
    const token = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) throw new Error('invalid value');
    index += token.length;
    return JSON.parse(token);
  };
  try {
    const result = value(); ws();
    if (index !== source.length) throw new Error('trailing JSON content');
    return result;
  } catch (error) { fail(`invalid strict JSON: ${error.message}`); }
}
