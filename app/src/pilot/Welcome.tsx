import { ArrowRight, Bug, Check, Sparkles, WandSparkles } from 'lucide-react';
import { VibeMark } from '../design/Icon';
import type { LucideIcon } from 'lucide-react';

/**
 * The front door, before any run (#223).
 *
 * It describes the flow, not the permissions table: what a person needs here is
 * what happens when they type, because it is no longer obvious - the reply is
 * questions rather than a run. Three starters prepare a message; sending is
 * still the person's action, which is why each hands the composer focus rather
 * than sending.
 */

const STARTERS: readonly { icon: LucideIcon; title: string; detail: string; prompt: string }[] = [
  {
    icon: Sparkles,
    title: 'Build something new',
    detail: 'Turn an idea into a thoughtful plan.',
    prompt: 'I want to build a new feature. Help me shape the idea and make a plan.',
  },
  {
    icon: WandSparkles,
    title: 'Make it better',
    detail: 'Give existing code a fresh perspective.',
    prompt:
      'Help me improve this project. First, explore the code and suggest where we could make the biggest difference.',
  },
  {
    icon: Bug,
    title: 'Untangle a problem',
    detail: 'Find the cause. Work toward a fix.',
    prompt:
      'Help me investigate a problem in this project. Ask me what is going wrong, then explore the relevant code.',
  },
];

export function Welcome({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return (
    <section className="m-auto flex w-full max-w-2xl flex-col items-center text-center" aria-label="Start a conversation">
      <VibeMark large />
      <p className="mt-4 mb-2 text-chip uppercase tracking-[0.18em] text-secondary">
        A little direction. A lot of possibility.
      </p>
      <h1 className="m-0 text-balance text-title font-medium tracking-tight text-display">
        Good ideas deserve <em className="font-normal not-italic text-accent">great execution.</em>
      </h1>
      <p className="mt-3 mb-5 max-w-md text-body text-secondary">
        Bring the idea. Your pilot helps shape the brief, then Claude and Codex build, challenge, and
        refine it.
      </p>
      <div className="grid w-full grid-cols-1 gap-2.5 text-left sm:grid-cols-3">
        {STARTERS.map((s) => (
          <button
            type="button"
            className="group relative flex cursor-pointer flex-col items-start gap-1.5 rounded-md border border-rule-card bg-chrome p-3.5 text-left text-secondary transition-colors hover:border-accent-border hover:bg-card"
            key={s.title}
            onClick={() => onPrompt(s.prompt)}
          >
            <s.icon size={20} className="mb-1 text-accent-muted" aria-hidden="true" />
            <strong className="text-body-sm font-medium text-primary">{s.title}</strong>
            <span className="pr-5 text-label">{s.detail}</span>
            <ArrowRight
              size={16}
              className="absolute top-4 right-4 text-tertiary group-hover:text-primary"
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
      <p className="mt-4 mb-0 flex items-center gap-1.5 text-label text-tertiary">
        <Check size={14} aria-hidden="true" /> You review the brief and approve the run.
      </p>
    </section>
  );
}
