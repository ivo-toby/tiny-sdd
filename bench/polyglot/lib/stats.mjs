// Paired tests, pass-rate summaries and seeded sampling helpers. No dependencies.

// Mulberry32: small seeded PRNG returning floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(array, rng) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// pairs: [{ x: boolean, y: boolean }]. b = x only, c = y only.
// Exact two-sided binomial test on the discordant pairs.
export function mcnemar(pairs) {
  let b = 0;
  let c = 0;
  for (const pair of pairs) {
    if (pair.x && !pair.y) b += 1;
    else if (!pair.x && pair.y) c += 1;
  }
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1 };
  const k = Math.min(b, c);
  const logHalf = -n * Math.LN2;
  let logChoose = 0;
  let tail = 0;
  for (let i = 0; i <= k; i += 1) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logChoose + logHalf);
  }
  return { b, c, n, p: Math.min(1, 2 * tail) };
}

export function rate(passes, n) {
  return n > 0 ? passes / n : null;
}

// groupBy: array of result field names. Returns groups sorted by key.
export function summarize(results, { groupBy = [] } = {}) {
  const groups = new Map();
  for (const result of results) {
    const group = Object.fromEntries(groupBy.map((field) => [field, result[field] ?? null]));
    const key = groupBy.length === 0 ? 'all' : groupBy.map((field) => `${field}=${group[field]}`).join(' ');
    if (!groups.has(key)) groups.set(key, { key, group, n: 0, pass1: 0, pass2: 0 });
    const entry = groups.get(key);
    entry.n += 1;
    if (result.pass1) entry.pass1 += 1;
    if (result.pass2) entry.pass2 += 1;
  }
  return [...groups.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => ({
      ...entry,
      pass1Rate: rate(entry.pass1, entry.n),
      pass2Rate: rate(entry.pass2, entry.n),
    }));
}
