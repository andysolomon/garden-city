// Deterministic randomness. Every subsystem derives its own stream from the
// city seed plus a namespace tag, so adding calls in one subsystem never
// reshuffles another.
export class RNG {
  constructor(seed) { this.state = hashSeed(seed) >>> 0 || 0x9e3779b9; }
  next() { this.state = (this.state * 1664525 + 1013904223) >>> 0; return this.state / 4294967296; }
  float(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  bool(p = .5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
}

export function hashSeed(v) {
  const s = String(v); let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff).toString(36).toUpperCase();
}
