/**
 * Reads results.json and reports what happened.
 *
 * The comparison that matters is `loaded` against `on-duty`: same transcript,
 * same skill body, same task — the block is the only difference. Because the
 * two arms are run on the same trial index, the outcomes are paired, so the
 * right test is McNemar's: it looks only at the trials where the two arms
 * disagreed and asks whether the disagreements fall one way more often than a
 * coin would explain. Exact binomial, two-sided, no approximation.
 *
 * `clean` is here as the ceiling. If `loaded` matches `clean`, the skill did no
 * damage on that case and there was nothing for the block to recover — a null
 * result, reported as one.
 */

import { readFileSync } from 'node:fs';

type Trial = {
  case: string;
  arm: 'clean' | 'loaded' | 'placebo' | 'on-duty';
  trial: number;
  pass: boolean;
  violations: string[];
};

type Results = {
  model: string;
  trials: number;
  ranAt: string;
  tokens: { input: number; output: number };
  costUsd: number;
  results: Trial[];
};

const data: Results = JSON.parse(
  readFileSync(new URL('./results.json', import.meta.url), 'utf8'),
) as Results;

/** n choose k, exact, for the small n a paired bench produces. */
const choose = (n: number, k: number): number => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/**
 * Two-sided exact McNemar. b and c are the discordant counts.
 * Under the null each discordant pair is a fair coin, so the p-value is the
 * probability of a split at least as lopsided as the one observed.
 */
const mcnemar = (b: number, c: number): number => {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let tail = 0;
  for (let k = 0; k <= lo; k++) tail += choose(n, k) * Math.pow(0.5, n);
  return Math.min(1, 2 * tail);
};

const cases = [...new Set(data.results.map((r) => r.case))];
const arms = ['clean', 'loaded', 'placebo', 'on-duty'] as const;

const rate = (c: string, arm: string): { pass: number; n: number } => {
  const rows = data.results.filter((r) => r.case === c && r.arm === arm);
  return { pass: rows.filter((r) => r.pass).length, n: rows.length };
};

console.log(`model: ${data.model}   trials/arm/case: ${data.trials}   run: ${data.ranAt}`);
console.log(`cost: $${data.costUsd.toFixed(4)}  (${data.tokens.input} in / ${data.tokens.output} out)\n`);

const pad = (s: string, n: number): string => s.padEnd(n);
console.log(
  pad('case', 20) + arms.map((a) => pad(a, 12)).join('') + pad('McNemar', 12) + 'verdict',
);
console.log('-'.repeat(20 + 36 + 12 + 24));

let anyHarm = false;

for (const c of cases) {
  const cells = arms.map((a) => {
    const { pass, n } = rate(c, a);
    return pad(`${pass}/${n}`, 12);
  });

  // Paired, by trial index.
  const loaded = data.results.filter((r) => r.case === c && r.arm === 'loaded');
  const duty = data.results.filter((r) => r.case === c && r.arm === 'on-duty');
  let b = 0; // loaded passed, on-duty failed
  let d = 0; // loaded failed, on-duty passed
  for (const l of loaded) {
    const o = duty.find((r) => r.trial === l.trial);
    if (!o) continue;
    if (l.pass && !o.pass) b++;
    if (!l.pass && o.pass) d++;
  }
  const p = mcnemar(b, d);

  const clean = rate(c, 'clean');
  const load = rate(c, 'loaded');
  const harmed = load.pass < clean.pass;
  if (harmed) anyHarm = true;

  const verdict = !harmed
    ? 'no harm to recover (null)'
    : d > b
      ? 'block recovered it'
      : 'block did not help';

  console.log(pad(c, 20) + cells.join('') + pad(p < 0.001 ? '<0.001' : p.toFixed(4), 12) + verdict);
}

console.log('\nablation — placebo against on-duty (same slot, different text):');
for (const c of cases) {
  const pl = data.results.filter((r) => r.case === c && r.arm === 'placebo');
  const du = data.results.filter((r) => r.case === c && r.arm === 'on-duty');
  let b = 0;
  let d = 0;
  for (const l of pl) {
    const o = du.find((r) => r.trial === l.trial);
    if (!o) continue;
    if (l.pass && !o.pass) b++;
    if (!l.pass && o.pass) d++;
  }
  const p = mcnemar(b, d);
  const note =
    b + d === 0
      ? 'identical — the block text added nothing here'
      : d > b
        ? 'the block text is doing the work'
        : 'the placebo did better';
  console.log(`  ${pad(c, 20)} p=${p < 0.001 ? '<0.001' : p.toFixed(4)}  ${note}`);
}

console.log('\nviolations in the ungoverned arm:');
for (const c of cases) {
  const counts = new Map<string, number>();
  for (const r of data.results.filter((x) => x.case === c && x.arm === 'loaded')) {
    for (const v of r.violations) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const summary =
    [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([v, n]) => `${v}×${n}`).join(', ') ||
    'none';
  console.log(`  ${pad(c, 20)} ${summary}`);
}

if (!anyHarm) {
  console.log('\nNo case showed harm. The claim is not supported by this run.');
}
