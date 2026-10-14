// FORGE gate — workspace path glob matching.
//
// Pattern grammar (deliberately small): "/"-separated segments; "**" matches
// zero or more whole segments; "*" matches any characters within one segment;
// everything else is a literal. No brace expansion, no character classes —
// security-relevant matching must be auditable by reading a pattern.

export function matchPath(path: string, pattern: string): boolean {
  const segs = path.split("/").filter((s) => s.length > 0);
  const pats = pattern.split("/").filter((s) => s.length > 0);
  return matchSegs(segs, 0, pats, 0);
}

function matchSegs(segs: string[], si: number, pats: string[], pi: number): boolean {
  if (pi === pats.length) return si === segs.length;
  const pat = pats[pi]!;
  if (pat === "**") {
    // "**" may consume zero or more segments
    for (let k = si; k <= segs.length; k++) {
      if (matchSegs(segs, k, pats, pi + 1)) return true;
    }
    return false;
  }
  if (si >= segs.length) return false;
  if (!matchSegment(segs[si]!, pat)) return false;
  return matchSegs(segs, si + 1, pats, pi + 1);
}

function matchSegment(seg: string, pat: string): boolean {
  // single-segment glob: '*' wildcards, all other chars literal
  const regex = new RegExp(
    "^" + pat.split("*").map(escapeRe).join("[^/]*") + "$",
  );
  return regex.test(seg);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest literal prefix of a glob (wildcards stripped) — used for the
 *  documented attenuation approximation (ADR-0003 / grants.ts): a child glob
 *  is covered by a parent glob if the child's literal prefix path is matched
 *  by the parent pattern. */
export function literalPrefix(pattern: string): string {
  const segs = pattern.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "**" || seg.includes("*")) break;
    out.push(seg);
  }
  return out.join("/");
}
