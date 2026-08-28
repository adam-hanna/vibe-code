import { ANSWERS_SCHEMA, FINDINGS_SCHEMA, PLAN_SCHEMA } from '@src/schemas.js';
import { SLOTS, slotMeasured, slotRotatable } from '@src/slots.js';
import type { SlotName } from '@src/slots.js';
import type { AgentProvider } from '@src/runtime.js';
import { EFFORTS } from '@src/types.js';
import type { Config, Effort, PermissionMode, Sandbox } from '@src/types.js';

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

/**
 * The providers a role may be seated on.
 *
 * The whole of the provider choice: a role's configured value is one of these
 * names, or an object naming one of them (see `RoleValue`). Nothing else is a
 * provider, on either form.
 */
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
 * coherent: each role's default conversation, which is what every table
 * predating named slots meant. That used to be one conversation per provider and
 * is now per role - the reviewer's Codex conversation is not the critic's. See
 * `slotForRole`.
 */
export interface RoleSpec {
  provider: AgentProvider;
  access: Access;
  schema?: object | undefined;
  tools?: readonly string[] | undefined;
  slot?: SlotName | undefined;
  /**
   * The effort this role named for itself, and absent when it named none -
   * which means its provider's `claude.effort`/`codex.effort`, as every role
   * meant before this key existed. Absent rather than pre-resolved on purpose:
   * a table cannot then claim an override nobody wrote. See `effortFor`.
   */
  effort?: Effort | undefined;
  /**
   * The model this role named for itself, and absent when it named none - which
   * means its provider's `claude.model`/`codex.model`, as every role meant
   * before this key existed. Absent rather than pre-resolved for `effort`'s
   * reason: a table cannot then claim an override nobody wrote. See `modelFor`.
   */
  model?: string | undefined;
  /**
   * The timeout this role named for itself, and absent when it named none -
   * which means its provider's pair, chosen by access, as every role meant
   * before this key existed (#84). Absent rather than pre-resolved for the same
   * reason again, and here it carries a second job: `noteRoleProvenance` reads
   * the absence to decide whether a failed turn owes the user a note naming
   * `roles.<role>.timeoutMs`. See `turnTimeoutMs`.
   */
  timeoutMs?: number | undefined;
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
 * They are deliberately not a config surface - the choices a run makes are which
 * provider sits in each seat and, optionally, what effort that seat runs at.
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

/**
 * What a role may say about itself beyond who holds it.
 *
 * `provider` is required, and deliberately not optional-with-a-fallback: a
 * role's value is replaced *wholesale* on merge (see `mergeRoles`), so a legal
 * `{"effort": "max"}` would silently restore the default agent for a role an
 * earlier config had moved - a different agent, with no error and no log line.
 */
export interface RoleSetting {
  provider: AgentProvider;
  /** The reasoning effort this seat runs at, checked against a closed enum. */
  effort?: Effort | undefined;
  /**
   * The model this seat runs, checked only for being a non-empty string.
   *
   * Accepted on trust, and that is the whole of the validation decision (#60):
   * no config-time check for a model *name* exists, because the preflight probe
   * is an environment contract check rather than a model validator. It runs
   * `PROBE_MODEL` for Claude whatever `claude.model` says, and `cfg.codex.model`
   * for Codex - so it has never validated a role's model and is not made to. No
   * allowlist and no default table: guessing whether a model exists is the
   * never-invent-a-number rule applied to a name. A typo is caught by the run
   * summary before anything is spent, and by a turn failure that names
   * `roles.<role>.model` rather than the provider key (see `modelSource`).
   *
   * #46 refused this key rather than ignoring it, so nothing has to be
   * un-taught here: the refusal simply becomes a setting.
   */
  model?: string | undefined;
  /**
   * How long a turn in this seat gets, in milliseconds, and absent when the role
   * named none - which then means its provider's pair, chosen by access, as
   * every role meant before this key existed.
   *
   * Validated exactly as the provider keys it overrides are (`config.ts`'s
   * `claude.planTimeoutMs` and the Codex pair): finite and positive, and
   * deliberately NOT whole. Those keys accept a fractional number, and an
   * override stricter than the value it replaces is a trap.
   */
  timeoutMs?: number | undefined;
}

/** The config surface for one role: who holds it, optionally with what it overrides. */
export type RoleValue = AgentProvider | RoleSetting;

/**
 * The `roles` section as a user writes it: a provider name per role, or an
 * object naming the provider and, optionally, that role's own model (#60) and
 * effort (#46). Keeps the name it shipped with in #2.
 *
 * Either form can be *persisted*, not just written: `cmdRun` stores the
 * effective config, so a `state.config` written by this version carries whichever
 * form the run used, and a resume reads it back through the same `roleSetting`.
 * The string form is what every config predating #46 contains, and it is
 * unchanged - which is the compatibility claim, rather than any claim that
 * strings are all that is on disk.
 */
export type RoleProviders = Record<Role, RoleValue>;

/**
 * Who does what when a run says nothing: Claude plans and implements, Codex
 * critiques, answers and reviews. A run with no `roles` key behaves exactly as
 * every run before this key existed.
 *
 * Typed as providers rather than as `RoleProviders`: the default names no
 * effort, and saying so in the type keeps it that way.
 */
export const DEFAULT_ROLE_PROVIDERS: Record<Role, AgentProvider> = {
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
 * Which Codex conversation each job talks through.
 *
 * Per role, because one slot per provider stopped being able to state the truth
 * (#45): the reviewer must not form its judgement inside the conversation that
 * approved the plan, so it holds its own thread and every other Codex-seated
 * role keeps the one they have always had.
 */
const CODEX_SLOT: Readonly<Record<Role, SlotName>> = {
  // A writing role on Codex is refused outright while `codex.persistSession` is
  // on (see `roleRefusals`) and is one-shot without it, so it carries nothing
  // either way. It stays on `judge` so nothing about such a table changes here.
  planner: 'judge',
  implementer: 'judge',
  critic: 'judge',
  // Deliberately `judge`, not `review`. Answering the planner's blocking
  // questions is plan-side work, and the conversation that has argued about the
  // plan is the right one to answer questions about it. Under the rule below it
  // would otherwise read as an oversight.
  answerer: 'judge',
  // The one role that changes conversation, and the whole of #45.
  reviewer: 'review',
};

/**
 * The slot a table that names none means.
 *
 * Not the provider-name guessing this file exists to have deleted - it decides
 * no one's job and answers no question about who does what. It is the fallback
 * shape for a table that left the field out, and every table `tableFor` builds
 * names one.
 *
 * It used to be `Record<AgentProvider, SlotName>` - one conversation per
 * provider - which is what every table predating named slots described and what
 * two Codex conversations can no longer be expressed in. A table that names no
 * slot now means "the default conversation for this job", which is the same
 * answer for every role but the reviewer.
 */
function defaultSlot(role: Role, provider: AgentProvider): SlotName {
  // Claude has exactly one conversation, whatever the job: `main` is the session
  // rotation compacts, and there is no second Claude thread to be on.
  return provider === 'claude' ? 'main' : CODEX_SLOT[role];
}

/** The keys a role object may carry. Anything else is a mistake worth naming. */
const ROLE_OBJECT_KEYS: readonly string[] = ['provider', 'model', 'effort', 'timeoutMs'];

/**
 * `provider, model, effort and timeoutMs` - a list a person would read aloud.
 *
 * `join(' and ')` was fine while there were two keys and reads as
 * `provider and model and effort` with three, which is how #60 found it. Written
 * against the array's length rather than its contents, which is why #84's fourth
 * key needed nothing here but this sentence.
 */
function listKeys(keys: readonly string[]): string {
  if (keys.length < 2) return keys.join('');
  return `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

/**
 * A rejected value, as a message should show it back.
 *
 * The idiom the messages below use is `JSON.stringify(v) ?? String(v)`, which
 * renders `NaN` as `null` - a different mistake than the one the user made.
 * `Infinity` and `-Infinity` stringify to `null` too, and they are the only
 * other values that do: JSON has no way to write any of the three, so the
 * non-finite numbers are exactly the set this has to hand to `String` instead.
 * Scoped to the timeout check rather than applied to every message, so no
 * existing error text changes bytes.
 */
function shown(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value) ?? String(value);
}

/** What a role's configured value has to say to be one, worded for a user. */
function expectedRoleValue(role: Role, value: unknown): Error {
  return new Error(
    `roles.${role} is ${JSON.stringify(value) ?? String(value)}; expected ` +
      `${PROVIDERS.map((p) => `"${p}"`).join(' or ')}, or an object naming a provider and ` +
      `optionally a model, an effort and a timeout`,
  );
}

/**
 * One role's configured value, read once and checked completely.
 *
 * The only place a `roles.<role>` value is interpreted, so config validation and
 * the table build cannot disagree about what is legal - `validateRoles` in
 * src/config.ts calls this to check, and `tableFor` calls it to use. That matters
 * for the same reason `tableFor` has always checked its input: `state.config` is
 * the one field `validateStoredState` deliberately passes through unchecked, so
 * `rolesFor` can reach a value nothing has validated.
 *
 * Unknown keys are reported before a missing provider on purpose: a role object
 * carrying a key this shape does not take is a user reaching for a setting, and
 * answering that with "no provider" sends them the wrong way.
 */
export function roleSetting(role: Role, value: unknown): RoleSetting {
  if (typeof value === 'string') {
    if (!PROVIDERS.includes(value as AgentProvider)) throw expectedRoleValue(role, value);
    return { provider: value as AgentProvider };
  }
  if (!isRecord(value)) throw expectedRoleValue(role, value);

  for (const key of Object.keys(value)) {
    if (!ROLE_OBJECT_KEYS.includes(key)) {
      throw new Error(
        `roles.${role} has unknown key "${key}"; a role object takes ` +
          `${listKeys(ROLE_OBJECT_KEYS)}`,
      );
    }
  }

  const provider = value['provider'];
  if (provider === undefined) {
    throw new Error(
      `roles.${role} is an object with no provider. provider is required so that adding an ` +
        `effort cannot silently move a role back to the default agent.`,
    );
  }
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as AgentProvider)) {
    throw expectedRoleValue(role, provider);
  }

  const effort = value['effort'];
  if (effort !== undefined && (typeof effort !== 'string' || !EFFORTS.includes(effort as Effort))) {
    throw new Error(
      `roles.${role}.effort is ${JSON.stringify(effort) ?? String(effort)}; must be one of ` +
        `${EFFORTS.join(', ')}`,
    );
  }

  // All config can check about a model is that it is a name at all. Whitespace
  // is rejected with the empty string rather than trimmed: `--model " "` is a
  // spawn with no model, and silently repairing what a user wrote is the failure
  // the whole of this key's design is strict to prevent. The value is stored
  // verbatim for the same reason.
  const model = value['model'];
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error(
      `roles.${role}.model is ${JSON.stringify(model) ?? String(model)}; must be a non-empty ` +
        `model name string, or absent for ${provider}.model`,
    );
  }

  // The provider keys this overrides are checked for being finite and positive
  // and nothing more (`claude.planTimeoutMs`, the Codex pair), so this is too:
  // a per-role override that refused a fractional number the key it replaces
  // accepts would be a trap. `typeof` first, so `Number.isFinite` is never
  // handed a string that a coercing check would have let through - "30m" is a
  // config error, not 30.
  const timeoutMs = value['timeoutMs'];
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new Error(
      `roles.${role}.timeoutMs is ${shown(timeoutMs)}; must be a positive number of ` +
        `milliseconds, or absent for ${provider}'s own timeout`,
    );
  }

  // Spread rather than assigned, for the reason `tableFor` spreads them: a role
  // that named neither must carry neither key, not two holding undefined.
  return {
    provider: provider as AgentProvider,
    ...(effort === undefined ? {} : { effort: effort as Effort }),
    ...(model === undefined ? {} : { model }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * Join an assignment with the jobs to make a table.
 *
 * Loud about a value it does not recognise - a provider that is not one of the
 * two, an effort outside the enum, a key a role object does not take - rather
 * than indexing `DEFAULT_SLOT` with garbage or handing `--effort turbo` to a
 * provider. Config validation normally makes that unreachable, but
 * `state.config` is the one field `validateStoredState` deliberately passes
 * through unchecked - `applyOverrides` validates it on the path that uses it -
 * and an error naming the role beats a crash three frames away. The reading
 * itself is `roleSetting`'s, so this cannot drift from what config accepts.
 */
export function tableFor(providers: RoleProviders): RoleTable {
  if (!isRecord(providers)) {
    throw new Error(
      'roles must be an object mapping role names to "claude" or "codex", or to an object ' +
        'naming a provider and optionally a model, an effort and a timeout',
    );
  }
  const table = {} as RoleTable;
  for (const role of ROLE_NAMES) {
    const setting = roleSetting(role, providers[role]);
    table[role] = {
      ...JOBS[role],
      provider: setting.provider,
      slot: defaultSlot(role, setting.provider),
      // Spread rather than assigned: a role that named no effort must have no
      // `effort` key at all, not one holding undefined. The absent key is what
      // says "this role means its provider's", and `exactOptionalPropertyTypes`
      // keeps the two distinguishable.
      ...(setting.effort === undefined ? {} : { effort: setting.effort }),
      // The same rule, for the same reason: an absent key is what says "this
      // role means its provider's model".
      ...(setting.model === undefined ? {} : { model: setting.model }),
      // And again: an absent key is what says "this role means its provider's
      // timeout", and `exactOptionalPropertyTypes` keeps the two apart.
      ...(setting.timeoutMs === undefined ? {} : { timeoutMs: setting.timeoutMs }),
    };
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
  const slot = spec.slot ?? defaultSlot(role, spec.provider);
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

/**
 * How many distinct Codex conversations this run actually holds.
 *
 * Derived from the table, never from a constant: `codex.persistSession` used to
 * mean "one thread for the whole run", and since #45 it means "each Codex
 * conversation is carried" - two of them under the default assignment, because
 * the reviewer no longer judges the code from inside the conversation that
 * approved the plan. A summary line that still said *single thread* would be a
 * false statement about what the run is doing.
 *
 * Counted over the roles that take a turn, so a table whose only Codex role is
 * switched off reports none rather than describing a conversation nothing opens.
 */
export function codexConversations(cfg: Config, roles: RoleTable = rolesFor(cfg)): number {
  return new Set(enabledRolesFor('codex', cfg, roles).map((role) => slotForRole(role, roles))).size;
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
 *
 * The role's own figure wins over that pair where it named one (#84), which
 * makes the full order request -> role -> provider: `runTurn` already reads
 * `req.timeoutMs ?? turnTimeoutMs(...)`, so a caller with a reason of its own
 * still outranks the table and no call site changed to give the role its say.
 * `effortFor`'s rule, for the third setting a role may name.
 */
export function turnTimeoutMs(role: Role, cfg: Config, roles: RoleTable = rolesFor(cfg)): number {
  const spec = roles[role];
  // The role's own where it named one; otherwise byte-identically what this
  // function computed before the key existed, access-based pair selection and
  // all. That equality is the compatibility claim - see role-timeout.test.ts,
  // which enumerates every role on both providers rather than sampling.
  if (spec.timeoutMs !== undefined) return spec.timeoutMs;
  if (spec.provider === 'claude') {
    return spec.access === 'write' ? cfg.claude.implementTimeoutMs : cfg.claude.planTimeoutMs;
  }
  return spec.access === 'write' ? cfg.codex.implementTimeoutMs : cfg.codex.timeoutMs;
}

/**
 * The reasoning effort a turn in this role runs at.
 *
 * The role's own if it named one, and its provider's otherwise - which is what
 * every run before this key existed did, and what every role on a string value
 * still does. `claude.effort` and `codex.effort` are still the setting for the
 * seat rather than being replaced by this: two roles on one provider could not
 * differ before, which is the whole of #46, and one that names nothing has not
 * asked to.
 */
export function effortFor(role: Role, cfg: Config, roles: RoleTable = rolesFor(cfg)): Effort {
  const spec = roles[role];
  return spec.effort ?? cfg[spec.provider].effort;
}

/**
 * The model a turn in this role is spawned with.
 *
 * `effortFor`'s rule, for the other setting a role may name (#60): the role's
 * own where it named one, and its provider's otherwise. `claude.model` and
 * `codex.model` remain the model every seat on that provider runs, and a role
 * that names nothing has not asked to differ - so under any table naming no
 * per-role model this returns, for every role, the identical string the site
 * that asked read directly before. That is the compatibility claim.
 *
 * Accepted on trust; see `RoleSetting.model` for why nothing validates the name.
 *
 * Unlike `effortFor` this is asked by more than the dispatch sites: a model is
 * also what a context measurement is attributed to and what a rotation decision
 * is made against, so the same resolver answers "which model is this turn's" for
 * all three. See `shouldRotate` and `rotateSession`.
 */
export function modelFor(role: Role, cfg: Config, roles: RoleTable = rolesFor(cfg)): string {
  const spec = roles[role];
  return spec.model ?? cfg[spec.provider].model;
}

/**
 * The setting that named this role's model, as a user would edit it.
 *
 * For the one place it matters: a turn that failed under a model the user typed.
 * Shown `codex.model` when the name came from `roles.reviewer.model`, a user
 * edits the wrong line - and the two keys can now hold different strings, so the
 * provider key is no longer a safe thing to name by default.
 */
export function modelSource(role: Role, roles: RoleTable = ROLES): string {
  const spec = roles[role];
  return spec.model === undefined ? `${spec.provider}.model` : `roles.${role}.model`;
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
    const shared = [firstShared, ...restShared];
    const named = namePaths(shared);
    // Whether they share a *conversation* is a different fact from sharing a
    // provider, and claiming memory a one-shot thread does not have would be a
    // false statement in the one place a user acts on it. Asked of each role
    // rather than of the first: a provider no longer has one conversation (#45),
    // so "does any of them sit in the implementer's conversation, and is that
    // conversation carried" is now two questions this has to actually ask. Every
    // table that runs today answers exactly as it did - a Codex implementer
    // needs `persistSession` off before `roleRefusals` will let it run at all.
    const implementerSlot = slotForRole('implementer', roles);
    const persists =
      shared.some((role) => slotForRole(role, roles) === implementerSlot) &&
      SLOTS[implementerSlot].persists(cfg);
    if (persists) {
      // Unchanged, and asked first: a carried shared conversation is the
      // dominant fact whatever models the two seats name, because the judge
      // remembers the writing either way.
      warnings.push(
        `${named} share the implementer's ${implementer} conversation, so the judge remembers ` +
          `writing the code it is judging. Review independence is most of what this tool buys; ` +
          `the run continues without it.`,
      );
    } else {
      // "the same provider and model" was true while a model was uniform per
      // provider, and is false the moment two seats on one provider name
      // different ones (#60). A warning that states something false is worse
      // than no warning, so the group is split by the fact the sentence rests
      // on and each half is told only what is true of it. Same-model first, so
      // a table with both prints in a stable order - and a table where every
      // shared role matches gets today's sentence, verbatim.
      const implementerModel = modelFor('implementer', cfg, roles);
      const sameModel = shared.filter((role) => modelFor(role, cfg, roles) === implementerModel);
      const otherModel = shared.filter((role) => modelFor(role, cfg, roles) !== implementerModel);
      if (sameModel.length > 0) {
        warnings.push(
          `${namePaths(sameModel)} run on the same provider and model as the implementer ` +
            `(${implementer}), so their judgement is not independent of the code's author. Each ` +
            `turn is one-shot, so no conversation is shared; the run continues.`,
        );
      }
      if (otherModel.length > 0) {
        // Weaker than the sentence above, and deliberately still said: a
        // different model is not the code's author, which is most of what the
        // warning asks for - but the shared provider is a real remainder, and
        // stating it without a verdict it cannot support is what this file's
        // rule allows.
        const named = otherModel
          .map((role) => `${`roles.${role}`} (${modelFor(role, cfg, roles)})`)
          .join(', ');
        warnings.push(
          `${named} run on the implementer's provider (${implementer}) but on a different model ` +
            `than the implementer (${implementerModel}). Each turn is one-shot, so no conversation ` +
            `is shared and the judge is not the model that wrote the code; the shared provider is ` +
            `what remains of the dependence, and the run continues.`,
        );
      }
    }
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
      // Asked of every named role, not of the first. What is still true is that
      // each Codex conversation is measured against the same setting -
      // `codex.contextWindow` is a fact about the model - so the answer is the
      // same for all of them; what is no longer true is that a provider has one
      // conversation to ask about (#45), and a warning must not rest on it.
      const measured = generativeOnCodex.every((role) =>
        slotMeasured(cfg, slotForRole(role, roles)),
      );
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

  // W5: `codex.contextWindow` is one number, and a table may now name two Codex
  // models (#60). The window stays provider-level - "the Codex context window is
  // a setting, not a derivation" is settled, and a per-role window is a config
  // surface this change does not open - so the honest response is to say that at
  // most one of those conversations is measured against its own model's window.
  // Conditional on the setting being present because an unset window measures
  // neither thread, which W2 and W3 already describe, and conditional on the
  // roles being enabled so a conversation nothing opens cannot fire it. Silent
  // on every default run and on every run that sets nothing.
  if (cfg.codex.contextWindow != null) {
    const byModel = new Map<string, Role[]>();
    for (const role of enabledRolesFor('codex', cfg, roles)) {
      const model = modelFor(role, cfg, roles);
      byModel.set(model, [...(byModel.get(model) ?? []), role]);
    }
    if (byModel.size > 1) {
      const listed = [...byModel.entries()]
        .map(([model, held]) => `${model} (${namePaths(held)})`)
        .join(', ');
      warnings.push(
        `This run holds Codex roles on ${byModel.size} different models - ${listed} - and ` +
          `codex.contextWindow (${cfg.codex.contextWindow}) is one setting describing one model. ` +
          'Occupancy, the ctx% display and the context.compactAboveRatio threshold for at least ' +
          'one of those conversations are therefore computed against a window that is not its ' +
          "model's. Set codex.contextWindow for the model whose thread matters, or unset it to " +
          'measure neither.',
      );
    }
  }

  return warnings;
}
