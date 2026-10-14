// FORGE codec — canonical JSON.
//
// CANONICALIZATION RULE (normative; mirrors architecture/DATA-CONTRACTS.md,
// ADR-007, and aligns with RFC 8785 / JCS):
//
//   1. Input must be a pure JSON value: string | number | boolean | null |
//      array | object. undefined, functions, symbols, bigint, NaN, Infinity
//      are rejected (they are not representable deterministically).
//   2. Strings must be valid Unicode (no lone surrogates); they are escaped
//      per ECMAScript JSON.stringify (minimal escaping: ", \, control chars;
//      non-ASCII emitted raw as UTF-8).
//   3. Numbers are serialized with ECMAScript Number::toString semantics —
//      exactly what JSON.stringify produces (shortest round-trip form).
//      -0 normalizes to 0.
//   4. Object keys are sorted lexicographically by UTF-16 code unit order
//      (Array.prototype.sort's default for strings). Key order in the input
//      is irrelevant: {a:1,b:2} and {b:2,a:1} produce identical bytes.
//   5. Array order is preserved (arrays are ordered by contract).
//   6. Output is UTF-8 with no whitespace.
//
// We do NOT rely on unqualified JSON.stringify for whole-record
// canonicalization: unsorted keys would make encoding insertion-order
// dependent. The rule is implemented here explicitly; JSON.stringify is used
// only for leaf strings/numbers, where ECMAScript guarantees determinism.

export class CanonicalizationError extends TypeError {
  constructor(public readonly path: string, message: string) {
    super(`canonical JSON: ${message} (at ${path})`);
    this.name = "CanonicalizationError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDFFF]/;
function hasLoneSurrogate(s: string): boolean {
  // Well-formed pairs are fine; single unpaired halves are not.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next === undefined || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export type JsonLike =
  | string
  | number
  | boolean
  | null
  | JsonLike[]
  | { [key: string]: JsonLike };

export function canonicalize(value: JsonLike, path: string = "$"): string {
  switch (typeof value) {
    case "string":
      if (LONE_SURROGATE.test(value) && hasLoneSurrogate(value)) {
        throw new CanonicalizationError(path, "lone surrogates are not valid Unicode");
      }
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(path, "NaN and Infinity are not JSON");
      }
      if (value === 0) return "0"; // normalize -0
      return JSON.stringify(value);
    }
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError(path, "non-plain object");
      }
      const keys = Object.keys(value).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0, // UTF-16 code unit order
      );
      const parts: string[] = [];
      for (const k of keys) {
        const v = (value as { [key: string]: JsonLike })[k];
        if (v === undefined) {
          throw new CanonicalizationError(`${path}.${k}`, "undefined value");
        }
        parts.push(`${canonicalize(k, `${path}.<key>`)}:${canonicalize(v, `${path}.${k}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalizationError(path, `unsupported type ${typeof value}`);
  }
}
