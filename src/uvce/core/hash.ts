/**
 * Runtime hashing for small canonical strings (appearance / cache keys). Asset CONTENT hashes are SHA-256,
 * computed at build time by the compiler and only compared at runtime.
 */
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** FNV-1a 64-bit over the UTF-8 bytes of `input`, as 16 lowercase hex chars. */
export function fnv1a64Hex(input: string): string {
  let h = FNV64_OFFSET;
  for (const byte of encoder.encode(input)) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Deterministic JSON: object keys sorted, no whitespace. Rejects values that JSON would silently change
 * (undefined in arrays, non-finite numbers, functions) so two different inputs cannot collide by accident.
 * `undefined` object properties are omitted (treated as "not set").
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((v: unknown) => {
            if (v === undefined) throw new TypeError('canonicalJson: undefined array element');
            return canonicalJson(v);
          })
          .join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
