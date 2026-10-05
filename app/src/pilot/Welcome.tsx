import { Icon, VibeMark } from '../design/Icon';

const STARTERS = [
  { icon: 'spark', title: 'Build something new', detail: 'Turn an idea into a thoughtful plan.', prompt: 'I want to build a new feature. Help me shape the idea and make a plan.' },
  { icon: 'improve', title: 'Make it better', detail: 'Give existing code a fresh perspective.', prompt: 'Help me improve this project. First, explore the code and suggest where we could make the biggest difference.' },
  { icon: 'bug', title: 'Untangle a problem', detail: 'Find the cause. Work toward a fix.', prompt: 'Help me investigate a problem in this project. Ask me what is going wrong, then explore the relevant code.' },
] as const;

export function Welcome({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <section className="v-welcome" aria-label="Start a conversation">
    <VibeMark large />
    <p className="v-welcome__eyebrow">A little direction. A lot of possibility.</p>
    <h1>Good ideas deserve<br /><em>great execution.</em></h1>
    <p className="v-welcome__lead">Bring the idea. Your pilot helps shape the brief,<br className="v-welcome__break" /> then Claude and Codex build, challenge, and refine it.</p>
    <div className="v-welcome__starters">
      {STARTERS.map((s) => <button className="v-starter" key={s.title} onClick={() => onPrompt(s.prompt)}>
        <span className="v-starter__icon"><Icon name={s.icon} size={21} /></span>
        <strong>{s.title}</strong><span>{s.detail}</span>
        <Icon name="arrow" size={16} />
      </button>)}
    </div>
    <p className="v-welcome__assurance"><Icon name="check" size={14} /> You review the brief and approve the run.</p>
  </section>;
}
