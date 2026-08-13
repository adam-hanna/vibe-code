import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config, ConfigOverrides, Effort, LoadedConfig, Sandbox } from '@src/types.js';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SANDBOXES: readonly Sandbox[] = ['read-only', 'workspace-write', 'danger-full-access'];

export const DEFAULTS: Config = {
  claude: {
    // Matches the interactive workflow this tool automates: opus, medium thinking.
    model: 'opus',
    effort: 'medium',
    planTimeoutMs: 30 * 60 * 1000,
    implementTimeoutMs: 90 * 60 * 1000,
  },
  codex: {
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    // Critique and review never need write access.
    sandbox: 'read-only',
    timeoutMs: 45 * 60 * 1000,
    persistSession: true,
  },
  loop: {
    maxPlanRounds: 5,
    maxReviewRounds: 5,
    // Two models disagreeing in a stable cycle will not converge by being asked again.
    oscillationThreshold: 2,
  },
  budget: {
    // NOT a spend limit on a Claude subscription - the CLI derives this from
    // token counts at API rates and nothing is billed. It is a work-volume
    // brake. The Codex CLI reports no cost at all, so this covers half the run.
    maxCostUsd: 25,
    maxTokens: 0,
    waitOnRateLimit: true,
    maxWaitMinutes: 360,
  },
  questions: {
    // Codex answers Claude's blocking questions first. Anything Codex flags as
    // product intent, or answers with low confidence, still escalates.
    askCodex: true,
    answerNonBlocking: true,
    escalateOnDefer: true,
    escalateOnLowConfidence: true,
  },
  git: {
    // Implementation runs with permissions bypassed; keep it off the working branch.
    useBranch: true,
    branchPrefix: 'vibe/',
    commitEachRound: true,
  },
  context: {
    enabled: true,
    compactAboveRatio: 0.5,
    compactDuringCodex: true,
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge one config section, ignoring keys the section does not define. */
function mergeSection<T extends object>(base: T, override: unknown): T {
  if (!isRecord(override)) return base;
  const out: T = { ...base };
  for (const key of Object.keys(base) as (keyof T)[]) {
    const v = override[key as string];
    if (v !== undefined) out[key] = v as T[keyof T];
  }
  return out;
}

function mergeConfig(base: Config, override: unknown): Config {
  if (!isRecord(override)) return base;
  return {
    claude: mergeSection(base.claude, override['claude']),
    codex: mergeSection(base.codex, override['codex']),
    loop: mergeSection(base.loop, override['loop']),
    budget: mergeSection(base.budget, override['budget']),
    questions: mergeSection(base.questions, override['questions']),
    git: mergeSection(base.git, override['git']),
    context: mergeSection(base.context, override['context']),
  };
}

/** Precedence: defaults < vibe.config.json in the target repo < CLI flags. */
export function loadConfig(targetDir: string, overrides: ConfigOverrides = {}): LoadedConfig {
  const configPath = path.join(targetDir, 'vibe.config.json');
  let fromFile: unknown = {};

  if (existsSync(configPath)) {
    try {
      fromFile = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid vibe.config.json: ${message}`);
    }
  }

  const merged = mergeConfig(mergeConfig(DEFAULTS, fromFile), overrides);
  validate(merged);
  return { ...merged, configPath: existsSync(configPath) ? configPath : null };
}

function validate(cfg: Config): void {
  if (!EFFORTS.includes(cfg.claude.effort)) {
    throw new Error(`claude.effort must be one of ${EFFORTS.join(', ')}`);
  }
  if (!EFFORTS.includes(cfg.codex.effort)) {
    throw new Error(`codex.effort must be one of ${EFFORTS.join(', ')}`);
  }
  if (!SANDBOXES.includes(cfg.codex.sandbox)) {
    throw new Error(`codex.sandbox must be one of ${SANDBOXES.join(', ')}`);
  }
  for (const key of ['maxPlanRounds', 'maxReviewRounds', 'oscillationThreshold'] as const) {
    const v = cfg.loop[key];
    if (!Number.isInteger(v) || v < 1) throw new Error(`loop.${key} must be a positive integer`);
  }
  if (!Number.isFinite(cfg.budget.maxCostUsd) || cfg.budget.maxCostUsd <= 0) {
    throw new Error('budget.maxCostUsd must be a positive number');
  }
  if (!Number.isFinite(cfg.budget.maxTokens) || cfg.budget.maxTokens < 0) {
    throw new Error('budget.maxTokens must be zero (disabled) or a positive number');
  }
  if (!Number.isFinite(cfg.budget.maxWaitMinutes) || cfg.budget.maxWaitMinutes <= 0) {
    throw new Error('budget.maxWaitMinutes must be a positive number');
  }
  const ratio = cfg.context.compactAboveRatio;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new Error('context.compactAboveRatio must be between 0 and 1 (exclusive)');
  }
  for (const key of ['planTimeoutMs', 'implementTimeoutMs'] as const) {
    if (!Number.isFinite(cfg.claude[key]) || cfg.claude[key] <= 0) {
      throw new Error(`claude.${key} must be a positive number`);
    }
  }
  if (!Number.isFinite(cfg.codex.timeoutMs) || cfg.codex.timeoutMs <= 0) {
    throw new Error('codex.timeoutMs must be a positive number');
  }
}
