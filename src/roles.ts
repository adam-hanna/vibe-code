import { ANSWERS_SCHEMA, FINDINGS_SCHEMA, PLAN_SCHEMA } from '@src/schemas.js';
import { SLOTS, slotMeasured, slotRotatable } from '@src/slots.js';
import type { SlotName } from '@src/slots.js';
import type { AgentProvider } from '@src/runtime.js';
import type { Config, PermissionMode, Sandbox } from '@src/types.js';

/** Whether a turn may change the working tree. The one place that intent is stated. */
export type Access = 'read-only' | 'write';

export type Role = 'planner' | 'implementer' | 'critic' | 'answerer' | 'reviewer';

/** Every role, in a fixed order, so a table can be iterated and validated. */
export const ROLE_NAMES: readonly Role[] = [
  'planner',
  'implementer',
  'critic',
  'answerer',
  'reviewer',
];

/** The providers a role may be seated on. The config surface accepts these and nothing else. */
export const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex'];

/**
 * One shape for both providers.
 *
 * `schema` is optional on either: a Codex planner must be given `PLAN_SCHEMA`
 * and a Codex implementer has no schema at all, so "which provider" stopped
 * being the thing that decides whether one exists. It states what the turn is
 * *asked* for - `--json-schema` for Claude, `--output-schema` for Codex - and is
 * not a promise about what came back, which is why nothing parses at the seam.
 *
 * `slot` is optional because a table that names none still describes something
 * coherent: one conversation per provider, which is what every table predating
 * named slots meant. See `slotForRole`.
 */
export interface RoleSpec {
  provider: AgentProvider;
  access: Access;
  schema?: object | undefined;
  tools?: readonly string[] | undefined;
  slot?: SlotName | undefined;
}

/**
 * The shape of `ROLES`, so the functions below can be handed a different one.
 *
 * Built from config by `rolesFor`; `ROLES` remains the default table, for tests
 * and for leaf callers that genuinely have no config in hand.
 */
export type RoleTable = Record<Role, RoleSpec>;

/** Read-only toolset for a turn that may look but not touch. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
];

/**
 * What each job is, independent of who holds it.
 *
 * `access`, `schema` and the tool list are facts about the work: a reviewer is
 * read-only and returns findings whoever holds it, and an implementer writes.
 * They are deliberately not a config surface - the only choice a run makes is
 * which provider sits in each seat.
 */
const JOBS: Readonly<
  Record<Role, { access: Access; schema?: object; tools?: readonly string[] }>
> = {
  planner: { access: 'read-only', schema: PLAN_SCHEMA, tools: READ_ONLY_TOOLS },
  implementer: { access: 'write' },
  critic: { access: 'read-only', schema: FINDINGS_SCHEMA, tools: READ_ONLY_TOOLS },
  answerer: { access: 'read-only', schema: ANSWERS_SCHEMA, tools: READ_ONLY_TOOLS },
  reviewer: { access: 'read-only', schema: FINDINGS_SCHEMA, tools: READ_ONLY_TOOLS },
};

/** The config surface: one provider per role, and nothing else. */
export type RoleProviders = Record<Role, AgentProvider>;

/**
 * Who does what when a run says nothing: Claude plans and implements, Codex
 * critiques, answers and reviews. A run with no `roles` key behaves exactly as
 * every run before this key existed.
 */
export const DEFAULT_ROLE_PROVIDERS: RoleProviders = {
  planner: 'claude',
  implementer: 'claude',
  critic: 'codex',
  answerer: 'codex',
  reviewer: 'codex',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The slot a table that names none means: one conversation per provider, which
 * is what every table predating named slots described.
 *
 * Not the provider-name guessing this file exists to have deleted - it decides
 * no one's job and answers no question about who does what. It is the fallback
 * shape for a table that left the field out, and every table `tableFor` builds
 * names one.
 */
const DEFAULT_SLOT: Readonly<Record<AgentProvider, SlotName>> = {
  claude: 'main',
  codex: 'judge',
};

/**
 * Join an assignment with the jobs to make a table.
 *
 * Loud about a provider it does not recognise rather than indexing
 * `DEFAULT_SLOT` with garbage. Config validation normally makes that
 * unreachable, but `state.config` is the one field `validateStoredState`
 * deliberately passes through unchecked - `applyOverrides` validates it on the
 * path that uses it - and an error naming the role beats a crash three frames
 * away.
 */
export function tableFor(providers: RoleProviders): RoleTable {
  if (!isRecord(providers)) {
    throw new Error('roles must be an object mapping role names to "claude" or "codex"');
  }
  const table = {} as RoleTable;
  for (const role of ROLE_NAMES) {
    const provider = providers[role];
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`roles.${role} is ${JSON.stringify(provider)}; expected "claude" or "codex"`);
    }
    table[role] = { ...JOBS[role], provider, slot: DEFAULT_SLOT[provider] };
  }
  return table;
}

/**
 * The table this config describes.
 *
 * Absence - a `state.config` stored before this key existed - falls back to the
 * default assignment. A *present* value does not, however malformed: `null` is
 * not the same fact as "no key", and reading it as one would run a different
 * agent than the config names, silently. `tableFor` reports it instead.
 */
export function rolesFor(cfg: Config): RoleTable {
  const providers: RoleProviders | undefined = cfg.roles;
  return tableFor(providers === undefined ? DEFAULT_ROLE_PROVIDERS : providers);
}

/**
 * The default table, for tests and for leaf callers with no config in hand.
 * Built through `tableFor`, so it cannot drift from what a configured table is.
 */
export const ROLES: RoleTable = tableFor(DEFAULT_ROLE_PROVIDERS);

/**
 * The conversation this role talks through.
 *
 * The pairing is checked, not assumed: dispatch routes by the role's provider
 * while ids and lifecycle come from the slot, so a mis-seated slot would hand a
 * client-minted Claude id to `codex exec resume`, or run a Claude turn off a
 * provider-origin slot that has no id to spawn under. Loud here beats wrong
 * there, and it cannot fire under `ROLES`, which is a constant this repo owns
 * and a test pins.
 */
export function slotForRole(role: Role, roles: RoleTable = ROLES): SlotName {
  const spec = roles[role];
  const slot = spec.slot ?? DEFAULT_SLOT[spec.provider];
  if (SLOTS[slot].provider !== spec.provider) {
    throw new Error(
      `role "${role}" is seated on provider "${spec.provider}" but slot "${slot}" is a ` +
        `${SLOTS[slot].provider} conversation`,
    );
  }
  return slot;
}

export function claudePermission(access: Access): PermissionMode {
  return access === 'write' ? 'bypassPermissions' : 'plan';
}

/**
 * Read-only yields the configured sandbox rather than the literal 'read-only'.
 *
 * `codex.sandbox` is a user setting, and cli.ts already warns about a
 * non-default one rather than forbidding it. Hardcoding the literal here would
 * silently discard that setting on the first Codex turn - a behaviour change,
 * which this seam is not allowed to make.
 */
export function codexSandbox(access: Access, cfg: Config): Sandbox {
  return access === 'write' ? 'workspace-write' : cfg.codex.sandbox;
}

/**
 * The roles this provider actually takes a turn in: held in this table AND not
 * switched off by config.
 *
 * The single definition of "what does this provider do on this run", and the one
 * every enforcement site must ask. Held-but-disabled and not-held are the same
 * answer, because both mean no turn is ever dispatched to this provider for that
 * role. Two sites used to answer it separately and neither consulted
 * `roleEnabled`, so a Codex holding only the answerer with
 * `questions.askCodex: false` - a provider that never runs - could still fail the
 * run at preflight on a widened `codex.sandbox`.
 *
 * Not the same question as `describedRole`, which picks the label a *prompt*
 * calls an agent by; a held role is a fair thing to name even where a switch
 * skips its turn.
 */
export function enabledRolesFor(
  provider: AgentProvider,
  cfg: Config,
  roles: RoleTable = rolesFor(cfg),
): Role[] {
  return ROLE_NAMES.filter((role) => roles[role].provider === provider && roleEnabled(role, cfg));
}

/**
 * The strongest access this provider can hold on this run.
 *
 * Derived from the table rather than from the provider's name, so preflight's
 * enforcement level cannot drift out of step with what a turn is actually
 * spawned with. The sandbox clause is not a second notion of write capability:
 * `codexSandbox('read-only', cfg)` is literally what a read-only Codex turn is
 * spawned with, and `--no-codex-session` plus `workspace-write` yields a Codex
 * that can rewrite the tree on every turn while every table entry still says
 * read-only.
 */
export function providerAccess(
  provider: AgentProvider,
  cfg: Config,
  roles: RoleTable = rolesFor(cfg),
): Access {
  const held = enabledRolesFor(provider, cfg, roles);
  // No enabled role: no turn is dispatched to this provider, so there is nothing
  // it could write and nothing to enforce at write level. Checked first, because
  // the sandbox clause below describes what a Codex turn is spawned with - and
  // none is.
  if (held.length === 0) return 'read-only';
  if (held.some((role) => roles[role].access === 'write')) return 'write';
  if (provider === 'codex' && codexSandbox('read-only', cfg) !== 'read-only') return 'write';
  return 'read-only';
}

/**
 * Which role an agent holding several is described by, most defining first.
 *
 * An explicit list rather than `ROLES`' declaration order, which would pick
 * `planner` and `critic` and change the environment block a run has been
 * sending for its whole history. A provider-to-label constant would have been
 * the third option and is the thing this change exists to delete.
 */
const DESCRIBED_BY: readonly Role[] = [
  'implementer',
  'reviewer',
  'critic',
  'answerer',
  'planner',
];

/**
 * The role a prompt should call this provider by, or null if it holds none.
 *
 * Not `enabledRolesFor`: this is what an agent is *here to do*, which is a fair
 * thing to state about a held role even on a run where a switch skips its turn.
 * The enforcement question - does this provider take any turn at all - is
 * `enabledRolesFor`, and only that one consults config.
 */
export function describedRole(provider: AgentProvider, roles: RoleTable = ROLES): Role | null {
  return DESCRIBED_BY.find((role) => roles[role].provider === provider) ?? null;
}

/**
 * The role whose conversation `rotateSession` compacts.
 *
 * The rotation - its measurement, its handoff, its fresh id - belongs to a
 * *slot*, and this names the role whose slot that is. Stated as a role so the
 * rule below is about who is being interrupted rather than about a provider's
 * name; see `src/slots.ts` for what a slot's lifecycle is, and `rotatingSlot`
 * for the conversation this resolves to.
 */
export const ROTATING_ROLE: Role = 'implementer';

/** The conversation `rotateSession` compacts, under whichever table is in force. */
export function rotatingSlot(roles: RoleTable = ROLES): SlotName {
  return slotForRole(ROTATING_ROLE, roles);
}

/**
 * Whether a rotation may run alongside a turn in this role.
 *
 * Only when the conversation being compacted is not the one the work is being
 * done through. That was always the rule; it was written as
 * `compactDuringCodex`, then as a comparison of providers - both true of today's
 * table and neither the thing being asked. Two roles on one provider but on
 * different conversations may overlap; two on one conversation may not.
 */
export function rotatesConcurrentlyWith(workRole: Role, roles: RoleTable = ROLES): boolean {
  return slotForRole(workRole, roles) !== rotatingSlot(roles);
}

/**
 * Whether the run is configured to spend a turn on this role.
 *
 * `questions.askCodex` is provider-named for history - renaming it would touch
 * every stored `state.config` and every user's config file - but what it decides
 * is whether *the answerer* runs. Read by role, so a table that puts the
 * answerer elsewhere still honours it.
 */
export function roleEnabled(role: Role, cfg: Config): boolean {
  return role === 'answerer' ? cfg.questions.askCodex : true;
}

/** Weakest to strongest, so "the most a turn could be given" is a max. */
const SANDBOX_RANK: Readonly<Record<Sandbox, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

/**
 * The sandbox preflight must probe under: the strongest one any Codex turn on
 * this table is actually spawned with.
 *
 * Derived from `codexSandbox` rather than read off `cfg.codex.sandbox`, which is
 * what the probe used to do. The two agree for every value today, because no
 * Codex role writes - so nothing about any current configuration changes - but
 * they are two different statements, and the moment a Codex role holds `write`
 * the raw key would have preflight vouching for a sandbox no turn ever runs in.
 *
 * The maximum is taken over the sandboxes turns are *spawned* with and nothing
 * else. Seeding it with the read-only sandbox would put `cfg.codex.sandbox` back
 * in the running even where no turn receives it: a table whose only Codex role
 * writes is spawned with `workspace-write` however `codex.sandbox` reads, and
 * probing the wider `danger-full-access` would clear tools the run cannot then
 * execute - preflight passing for a turn that fails.
 */
export function codexProbeSandbox(cfg: Config, roles: RoleTable = rolesFor(cfg)): Sandbox {
  let strongest: Sandbox | null = null;
  for (const spec of Object.values(roles)) {
    if (spec.provider !== 'codex') continue;
    const sandbox = codexSandbox(spec.access, cfg);
    if (strongest === null || SANDBOX_RANK[sandbox] > SANDBOX_RANK[strongest]) strongest = sandbox;
  }
  // No Codex role at all: nothing is spawned, so the probe falls back to what a
  // read-only turn would have been given rather than inventing a wider one.
  return strongest ?? codexSandbox('read-only', cfg);
}

/** Which providers hold these roles, deduped and in a stable order. */
export function providersForRoles(
  wanted: readonly Role[],
  roles: RoleTable = ROLES,
): AgentProvider[] {
  const held = new Set(wanted.map((role) => roles[role].provider));
  return (['claude', 'codex'] as const).filter((provider) => held.has(provider));
}

/**
 * How long a turn in this role gets.
 *
 * The split it replaces was a role fact stated as a provider one: implementing
 * takes longer than reviewing, so Claude got two keys and Codex one. Which key
 * is read is decided by the role's access, for both providers now that a Codex
 * role can write: `codex.timeoutMs` is the reviewing figure and
 * `codex.implementTimeoutMs` the writing one, the same pair Claude has had.
 */
export function turnTimeoutMs(role: Role, cfg: Config, roles: RoleTable = rolesFor(cfg)): number {
  const spec = roles[role];
  if (spec.provider === 'claude') {
    return spec.access === 'write' ? cfg.claude.implementTimeoutMs : cfg.claude.planTimeoutMs;
  }
  return spec.access === 'write' ? cfg.codex.implementTimeoutMs : cfg.codex.timeoutMs;
}

/** What a log line calls each agent. */
const PROVIDER_LABEL: Readonly<Record<AgentProvider, string>> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * The name a log line should use for whoever holds this role.
 *
 * `'Claude is planning'` was true of one table and read as a fact about the
 * tool. Under the default assignment every line this produces is byte-identical
 * to the one it replaced.
 */
export function holderLabel(role: Role, roles: RoleTable = ROLES): string {
  return PROVIDER_LABEL[roles[role].provider];
}

/**
 * The roles that produce the work product rather than judge it.
 *
 * Two things hang off this. Their conversation grows across every revision and
 * fix round, so a Codex seat is worth warning about; and when such a role has no
 * memory it must be handed the plan of record, because `revisePlanPrompt` and
 * `fixPrompt` deliberately do not restate it. The judging roles are excluded on
 * purpose: they sit on Codex with `persistSession` on under the default table,
 * and a warning - or a prompt prefix - firing on every default run is not a
 * change this may make.
 */
export const GENERATIVE_ROLES: readonly Role[] = ['planner', 'implementer'];

/**
 * Assignments that cannot work, worded for a user. Empty means the table runs.
 *
 * `codex exec resume` takes no `-s` flag: a non-default sandbox applies to the
 * first turn and every resumed turn silently reverts to read-only. So a writing
 * Codex role with a persisted thread is either an implementer that cannot write
 * after turn one, or - if the flag were forced off silently - a run whose memory
 * quietly disappeared. Refused rather than repaired, so the choice stays the
 * user's.
 */
export function roleRefusals(cfg: Config, roles: RoleTable = rolesFor(cfg)): string[] {
  if (!cfg.codex.persistSession) return [];
  return ROLE_NAMES.filter(
    (role) => roles[role].provider === 'codex' && roles[role].access === 'write',
  ).map(
    (role) =>
      `roles.${role} is Codex and codex.persistSession is on. \`codex exec resume\` takes no ` +
      `-s flag, so the workspace-write sandbox applies to the first turn only and every ` +
      `resumed turn silently reverts to read-only. Set codex.persistSession to false ` +
      `(--no-codex-session) for a Codex ${role}.`,
  );
}

/** The judging roles, for the independence warning below. */
const JUDGING_ROLES: readonly Role[] = ['critic', 'answerer', 'reviewer'];

/**
 * What is worth saying out loud about a table that still runs.
 *
 * Each line is about one property of one table, and says only what is true of
 * it - a warning that overstates is worse than none, because the next one gets
 * ignored too. Under the default assignment this is empty.
 */
/** `roles.critic, roles.reviewer` - a list of settings, not one dotted path. */
const namePaths = (roles: readonly Role[]): string => roles.map((role) => `roles.${role}`).join(', ');

export function roleWarnings(cfg: Config, roles: RoleTable = rolesFor(cfg)): string[] {
  const warnings: string[] = [];
  const implementer = roles.implementer.provider;

  // W1: the judge is the agent that wrote the code. Review independence is most
  // of what this tool buys, so it is named - and the run continues.
  const [firstShared, ...restShared] = JUDGING_ROLES.filter(
    (role) => roles[role].provider === implementer,
  );
  if (firstShared !== undefined) {
    const named = namePaths([firstShared, ...restShared]);
    // Whether they share a *conversation* is a different fact from sharing a
    // provider, and claiming memory a one-shot thread does not have would be a
    // false statement in the one place a user acts on it. One slot answers for
    // all of them: a table gives a provider one conversation.
    const persists = SLOTS[slotForRole(firstShared, roles)].persists(cfg);
    warnings.push(
      persists
        ? `${named} share the implementer's ${implementer} conversation, so the judge remembers ` +
          `writing the code it is judging. Review independence is most of what this tool buys; ` +
          `the run continues without it.`
        : `${named} run on the same provider and model as the implementer (${implementer}), so ` +
          `their judgement is not independent of the code's author. Each turn is one-shot, so no ` +
          `conversation is shared; the run continues.`,
    );
  }

  // W2: rotation belongs to a slot, and not every slot has one. What is true of
  // such a slot changed once `codex.contextWindow` could be set: the thread is
  // still uncompactable, but it is no longer unmeasured. A warning that
  // contradicts the feature beside it teaches users to skip the next one, so the
  // measurement clause is conditional and the compaction clause is not.
  if (!slotRotatable(rotatingSlot(roles))) {
    const measured = slotMeasured(cfg, rotatingSlot(roles));
    warnings.push(
      `roles.implementer is ${implementer}, whose conversation has no rotation mechanism. ` +
        (measured
          ? 'Session rotation and context compaction are off for this run: that thread is ' +
            'measured against codex.contextWindow but nothing can compact it.'
          : 'Session rotation and context compaction are off for this run: nothing measures that ' +
            'thread and nothing can compact it.'),
    );
  }

  const [firstGenerative, ...restGenerative] = GENERATIVE_ROLES.filter(
    (role) => roles[role].provider === 'codex',
  );
  if (firstGenerative !== undefined) {
    const generativeOnCodex = [firstGenerative, ...restGenerative];
    const named = namePaths(generativeOnCodex);
    // W3: a persisted Codex thread doing generative work grows. Whether anything
    // *measures* it is now a question about `codex.contextWindow`, so the sentence
    // this shipped with is only said while it is still true. What never changes is
    // that nothing can compact the thread.
    if (cfg.codex.persistSession) {
      // One slot answers for all of them: a table gives a provider one conversation.
      const measured = slotMeasured(cfg, slotForRole(firstGenerative, roles));
      warnings.push(
        measured
          ? `${named} run on a persisted Codex thread. Its context is measured against ` +
            'codex.contextWindow and warned about above context.compactAboveRatio, but nothing ' +
            'can compact it: it grows across every plan revision, question round and fix round ' +
            'with no handoff.'
          : `${named} run on a persisted Codex thread and nothing measures its context. It grows ` +
            'across every plan revision, question round and fix round with no threshold and no ' +
            'handoff.',
      );
    }
    // W4: the dollar ceiling never sees the expensive half of such a run.
    warnings.push(
      `${named} run on Codex, which reports no cost, so budget.maxCostUsd bounds only the Claude ` +
        'side and cannot see the expensive half of this run. budget.maxTokens still counts both ' +
        'agents.',
    );
  }

  return warnings;
}
