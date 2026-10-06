/**
 * A leaf, so every adapter can ask it without importing the module that spawns
 * those same adapters to list their models (`models.ts`).
 */

/**
 * The model value that means *pass no model at all*, so the CLI picks.
 *
 * At the owner's decision both run defaults follow the CLI's own: *"Follow both
 * defaults unless changed by the user."* Claude's own list offers `default` as
 * a value; Codex has no such name, so the flag is left off for both rather than
 * sending a word one of them would refuse. `modelArgs` is the one place that
 * rule lives.
 */
export const CLI_DEFAULT = 'default';

/** `[flag, model]`, or nothing when the model is the CLI's own default. */
export function modelArgs(flag: string, model: string): string[] {
  return model === CLI_DEFAULT ? [] : [flag, model];
}
