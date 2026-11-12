/**
 * The types are the documentation.
 *
 * Everything in this file exists to answer one question: at this exact moment,
 * which skills are in force, and who said so?
 *
 * The distinction that matters, and the one the ecosystem currently blurs:
 *
 *   retrieval  — choosing which skill might be relevant. Fuzzy by nature.
 *                Embeddings, a model, a keyword match: all fine, all guesses.
 *   activation — deciding whether a chosen skill is actually switched on, what
 *                it is allowed to touch, and what happens to it afterwards.
 *                Not a guess. Code, with the same answer every time.
 *
 * Frameworks are busy building the first and the mechanism for the second
 * (Strands `dynamic_loading`, Microsoft Agent Framework's load tool, LangChain
 * SkillsMiddleware). None of them decides. Strands' own feature request says
 * model-initiated loading "must be documented as a prompt-injection surface";
 * `Skill.allowed_tools` is marked "experimental: not yet enforced". A sticker,
 * not a lock. This library is the lock.
 */

/* ── capabilities ─────────────────────────────────────────────────────── */

/**
 * What a skill is allowed to reach. Deliberately coarse strings rather than an
 * enum: every host has its own tool names, and a capability vocabulary that
 * cannot be extended is a capability vocabulary that gets bypassed.
 *
 * The convention is `domain.verb` — `fs.read`, `fs.write`, `net.fetch`,
 * `shell.exec` — so a ceiling can be written against a domain prefix.
 */
export type Capability = string;

/* ── skills ───────────────────────────────────────────────────────────── */

/**
 * Where a skill came from, which is the single most useful fact about it.
 *
 * `configured` is a skill the host shipped deliberately: a human chose it
 * before the agent ran. `sandbox` was found on disk mid-run — a cloned repo's
 * `skills/` directory, say. `url` was fetched from the open internet.
 *
 * Trust is not a property of a skill's text. It is a property of its origin,
 * because the text is exactly what an attacker controls.
 */
export type SkillOrigin = 'configured' | 'sandbox' | 'url';

export type SkillManifest = {
  name: string;
  origin: SkillOrigin;
  /** What the skill SAYS it needs. A claim, not a grant. */
  declares: readonly Capability[];
  /** The body that would enter the model's context if this skill is activated. */
  instructions: string;
  /**
   * Content digest, supplied by the host.
   *
   * Present so that a skill which changed under the same name is a different
   * skill as far as the decision is concerned. A name is not an identity when
   * anyone can publish.
   */
  digest?: string;
};

/* ── requests ─────────────────────────────────────────────────────────── */

/**
 * Who asked. This is the field the whole library turns on.
 *
 * When `model` asks, the request originated inside text the model just read —
 * and that text may itself have come from a skill. A skill that can talk the
 * agent into activating another skill is a skill that can self-propagate, so
 * model-proposed activations are held to a stricter standard than host ones.
 */
export type Proposer = 'model' | 'host';

export type ActivationRequest = {
  action: 'activate' | 'deactivate';
  skill: SkillManifest;
  proposedBy: Proposer;
  /** What the agent is actually trying to do. Policies may read it; none must. */
  task?: string;
};

/* ── decisions ────────────────────────────────────────────────────────── */

/**
 * Three answers, and only three.
 *
 * `allow` carries `grants`, which may be NARROWER than what the skill declared.
 * That narrowing is the enforcement: a skill asking for `shell.exec` under a
 * read-only ceiling is not handed a warning, it is handed `fs.read`.
 *
 * `refuse` and `escalate` both carry `because` — one sentence a person can act
 * on. "Policy violation" is not a sentence a person can act on.
 */
export type Decision =
  | {
      verdict: 'allow';
      grants: readonly Capability[];
      rule: string;
      /** Capabilities the skill declared and did NOT get. Reported, never silent. */
      narrowed?: readonly Capability[];
    }
  | { verdict: 'refuse'; because: string; rule: string }
  | { verdict: 'escalate'; because: string; rule: string };

/** The two decisions a policy is permitted to reach. */
export type Objection = Extract<Decision, { verdict: 'refuse' | 'escalate' }>;

/**
 * A policy is a pure function, and it may only OBJECT.
 *
 * Returning null means "no objection from me", not "approved". Approval is the
 * absence of objections, which is why a policy cannot wave something through by
 * forgetting a case — the worst a buggy policy can do is fail to stop something,
 * never grant it.
 */
export type Policy = ((
  request: ActivationRequest,
  roster: readonly ActiveSkill[],
) => Objection | null) & { ruleName?: string };

/* ── the roster ───────────────────────────────────────────────────────── */

export type ActiveSkill = {
  name: string;
  origin: SkillOrigin;
  /** What it was actually granted, not what it asked for. */
  grants: readonly Capability[];
  digest?: string;
  activatedBy: Proposer;
  /** Monotonic counter, not a clock: tests should not depend on the time. */
  seq: number;
};
