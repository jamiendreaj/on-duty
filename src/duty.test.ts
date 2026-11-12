import test from 'node:test';
import assert from 'node:assert/strict';

import { decide, Roster } from './duty.js';
import type { DutyConfig } from './duty.js';
import {
  escalateCapabilities,
  hostOnlyOrigins,
  maxActive,
  originAllowlist,
  protectConfigured,
  requireDigest,
  strict as strictPolicies,
} from './policies.js';
import type { ActivationRequest, Capability, SkillManifest, SkillOrigin } from './types.js';

/* ── fixtures ─────────────────────────────────────────────────────────── */

const skill = (
  name: string,
  opts: {
    origin?: SkillOrigin;
    declares?: readonly Capability[];
    digest?: string | null;
    instructions?: string;
  } = {},
): SkillManifest => {
  const origin = opts.origin ?? 'configured';
  const digest = opts.digest === null ? undefined : (opts.digest ?? 'sha256:abc');
  return {
    name,
    origin,
    declares: opts.declares ?? ['fs.read'],
    instructions: opts.instructions ?? `# ${name}\nDo the thing.`,
    ...(digest === undefined ? {} : { digest }),
  };
};

const activate = (
  s: SkillManifest,
  proposedBy: 'model' | 'host' = 'host',
): ActivationRequest => ({ action: 'activate', skill: s, proposedBy });

const deactivate = (
  s: SkillManifest,
  proposedBy: 'model' | 'host' = 'host',
): ActivationRequest => ({ action: 'deactivate', skill: s, proposedBy });

const config = (over: Partial<DutyConfig> = {}): DutyConfig => ({
  ceiling: over.ceiling ?? ['fs.read', 'fs.write'],
  policies: over.policies ?? strictPolicies(),
});

/* ── the ceiling is the lock ──────────────────────────────────────────── */

test('a skill is granted the intersection of what it declared and the ceiling', () => {
  const d = decide(
    activate(skill('writer', { declares: ['fs.read', 'fs.write'] })),
    [],
    config({ ceiling: ['fs.read'], policies: [] }),
  );
  assert.equal(d.verdict, 'allow');
  assert.deepEqual(d.verdict === 'allow' ? d.grants : null, ['fs.read']);
});

test('capabilities dropped by the ceiling are reported, never silent', () => {
  const d = decide(
    activate(skill('writer', { declares: ['fs.read', 'fs.write'] })),
    [],
    config({ ceiling: ['fs.read'], policies: [] }),
  );
  assert.equal(d.verdict === 'allow' ? d.rule : null, 'ceiling');
  assert.deepEqual(d.verdict === 'allow' ? d.narrowed : null, ['fs.write']);
});

test('an off-duty skill holds nothing, whatever the transcript still says', () => {
  const roster = new Roster(config());
  const s = skill('reader');
  roster.request(activate(s));
  assert.equal(roster.allows('reader', 'fs.read'), true);

  roster.request(deactivate(s));
  assert.equal(roster.allows('reader', 'fs.read'), false);
  assert.equal(roster.grantsFor('reader'), null);
});

test('a skill cannot use a capability it was never granted', () => {
  const roster = new Roster(config({ ceiling: ['fs.read'] }));
  roster.request(activate(skill('reader', { declares: ['fs.read', 'fs.write'] })));
  assert.equal(roster.allows('reader', 'fs.read'), true);
  assert.equal(roster.allows('reader', 'fs.write'), false);
});

/* ── the model is not in charge ───────────────────────────────────────── */

test('the model cannot take a human-configured skill off duty', () => {
  const roster = new Roster(config());
  const guard = skill('compliance', { origin: 'configured' });
  roster.request(activate(guard, 'host'));

  const d = roster.request(deactivate(guard, 'model'));
  assert.equal(d.verdict, 'refuse');
  assert.equal(d.rule, 'protect-configured');
  assert.equal(roster.allows('compliance', 'fs.read'), true, 'still on duty after a refusal');
});

test('a model-proposed skill fetched from the internet goes to a person', () => {
  const d = decide(
    activate(skill('helpful-looking', { origin: 'url' }), 'model'),
    [],
    config(),
  );
  assert.equal(d.verdict, 'escalate');
  assert.equal(d.rule, 'host-only-origin');
});

test('the same skill proposed by the host is not escalated for its origin', () => {
  const d = decide(activate(skill('vendor-skill', { origin: 'url' }), 'host'), [], config());
  assert.equal(d.verdict, 'allow');
});

test('a grave capability goes to a person rather than being refused outright', () => {
  const d = decide(
    activate(skill('deployer', { declares: ['shell.exec'] })),
    [],
    config(),
  );
  assert.equal(d.verdict, 'escalate');
  assert.equal(d.rule, 'grave-capability');
});

/* ── identity and bloat ──────────────────────────────────────────────── */

test('a skill from outside the host arrives with a digest or not at all', () => {
  const d = decide(activate(skill('found-on-disk', { origin: 'sandbox', digest: null })), [], config());
  assert.equal(d.verdict, 'refuse');
  assert.equal(d.rule, 'require-digest');
});

test('a configured skill needs no digest, because a human already chose it', () => {
  const d = decide(activate(skill('shipped', { origin: 'configured', digest: null })), [], config());
  assert.equal(d.verdict, 'allow');
});

test('the wall has a limit, and the refusal says what to take down', () => {
  const roster = new Roster(config({ policies: [maxActive(2)] }));
  roster.request(activate(skill('a')));
  roster.request(activate(skill('b')));

  const d = roster.request(activate(skill('c')));
  assert.equal(d.verdict, 'refuse');
  assert.match(d.verdict === 'refuse' ? d.because : '', /a, b/);
});

test('re-activating a skill replaces its entry rather than stacking a second one', () => {
  const roster = new Roster(config({ ceiling: ['fs.read', 'fs.write'], policies: [] }));
  roster.request(activate(skill('x', { declares: ['fs.read', 'fs.write'] })));
  roster.request(activate(skill('x', { declares: ['fs.read'] })));

  assert.equal(roster.active().length, 1);
  assert.deepEqual(roster.grantsFor('x'), ['fs.read'], 'the newer, narrower grant wins');
});

/* ── precedence, because deletion is not available ───────────────────── */

test('the rendered block lists who is on duty and what they hold', () => {
  const roster = new Roster(config());
  roster.request(activate(skill('reader', { declares: ['fs.read'] })));
  const block = roster.render();

  assert.match(block, /<on-duty>/);
  assert.match(block, /reader \(configured\) may use: fs\.read/);
  assert.match(block, /<\/on-duty>/);
});

test('the block tells the model to ignore stale instructions, including activation requests', () => {
  const block = new Roster(config()).render();
  assert.match(block, /stale and must be ignored/);
  assert.match(block, /load, activate, trust, or re-enable/);
  assert.match(block, /On duty: nothing\./);
});

test('a deactivated skill disappears from the block', () => {
  const roster = new Roster(config());
  const s = skill('reader');
  roster.request(activate(s));
  assert.match(roster.render(), /reader/);

  roster.request(deactivate(s));
  assert.doesNotMatch(roster.render(), /reader/);
});

/* ── the properties the whole design rests on ────────────────────────── */

test('decide is pure: same inputs, same answer, and the roster is untouched', () => {
  const roster = new Roster(config());
  roster.request(activate(skill('reader')));
  const before = [...roster.active()];

  const req = activate(skill('other', { origin: 'url' }), 'model');
  const first = decide(req, roster.active(), config());
  const second = decide(req, roster.active(), config());

  assert.deepEqual(first, second);
  assert.deepEqual([...roster.active()], before);
});

test('a policy can only object, so the first objection in order wins', () => {
  const d = decide(
    activate(skill('nowhere', { origin: 'url', digest: null }), 'model'),
    [],
    config({
      policies: [originAllowlist(['configured']), requireDigest(), hostOnlyOrigins(['url'])],
    }),
  );
  assert.equal(d.rule, 'origin-allowlist', 'the first policy listed is the one that answers');
});

test('every refusal and escalation carries a sentence a person can act on', () => {
  const cases: ActivationRequest[] = [
    activate(skill('a', { origin: 'url' }), 'model'),
    activate(skill('b', { origin: 'sandbox', digest: null })),
    activate(skill('c', { declares: ['shell.exec'] })),
    deactivate(skill('d', { origin: 'configured' }), 'model'),
  ];
  const roster = new Roster(config());
  roster.request(activate(skill('d', { origin: 'configured' })));

  for (const req of cases) {
    const d = decide(req, roster.active(), config());
    assert.notEqual(d.verdict, 'allow', `${req.skill.name} should not be allowed`);
    if (d.verdict === 'allow') continue;
    assert.ok(d.because.length > 30, `${req.skill.name}: reason too thin`);
    assert.match(d.because, /\.$/, `${req.skill.name}: reason is not a sentence`);
  }
});

test('escalateCapabilities ignores a skill that declares nothing grave', () => {
  const d = decide(
    activate(skill('plain', { declares: ['fs.read'] })),
    [],
    config({ policies: [escalateCapabilities(['shell.exec'])] }),
  );
  assert.equal(d.verdict, 'allow');
});

test('protectConfigured does not stop the host from retiring its own skill', () => {
  const roster = new Roster(config());
  const s = skill('compliance', { origin: 'configured' });
  roster.request(activate(s));
  const d = roster.request(deactivate(s, 'host'));
  assert.equal(d.verdict, 'allow');
  assert.equal(roster.active().length, 0);
});
