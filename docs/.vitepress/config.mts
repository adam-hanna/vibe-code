import { defineConfig } from 'vitepress'

// The GitHub Pages project path for this repository - the ONLY place it is written.
// A custom domain later means adding docs/public/CNAME and changing this line to '/'.
const BASE = '/vibe-code/'

export default defineConfig({
  base: BASE,
  title: 'vibe',
  description:
    'Runs the plan, critique, implement and review loop between Claude Code and Codex, so you do not have to.',
  // An internal design note lives under docs/plans/ and is not part of the site.
  srcExclude: ['plans/**'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Reference', link: '/configuration' },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/adam-hanna/vibe-code' }],
    search: { provider: 'local' },
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/getting-started' },
          { text: 'The desktop app', link: '/app' },
          { text: 'How the loop works', link: '/how-it-works' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/cli' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Artifacts', link: '/artifacts' },
          { text: 'Exit codes', link: '/exit-codes' },
        ],
      },
      {
        text: 'Background',
        items: [{ text: 'Design notes', link: '/design-notes' }],
      },
    ],
  },
})
