import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The pilot's prose, drawn as the Markdown it is written in.
 *
 * Both CLIs and both vendors answer in GitHub-flavoured Markdown by habit, and
 * the pane drew it as preformatted text, so a reply arrived as pipes, asterisks
 * and backticks: *"Is it trying to print markdown? Do we not support markdown
 * in the pilot window?"* The prompt now says the pane renders it (`brief.ts`),
 * and this is the renderer.
 *
 * **The pilot's replies, and only those.** A person's own message stays
 * preformatted, because what they typed is what they typed. A plan stays a
 * `<pre>` for `PlansPane`'s reason: it is read for its exact words, in the form
 * the critic was shown.
 *
 * Three rules keep it a renderer and not a browser:
 * - **No raw HTML.** `react-markdown` drops it unless told otherwise, and it is
 *   not told otherwise: a model's reply must not be able to put an element on
 *   this page.
 * - **A link is never followed.** A click on an `<a>` in this webview navigates
 *   the whole app window away from the cockpit, with no back button. So a link
 *   is its text with the address beside it, selectable and copyable.
 * - **An image is its alt text.** Fetching one would be a request the person
 *   never made, and the CSP refuses it anyway.
 *
 * Every colour is a token class, for `audit:contrast`.
 */

const CODE_BLOCK =
  'm-0 overflow-x-auto whitespace-pre rounded-sm border border-rule-inner bg-panel px-3 py-2 font-mono text-mono-sm text-primary';

const components: Components = {
  p: ({ children }) => <p className="m-0">{children}</p>,
  h1: ({ children }) => <h3 className="m-0 mt-1 text-body font-semibold text-emphasis">{children}</h3>,
  h2: ({ children }) => <h3 className="m-0 mt-1 text-body font-semibold text-emphasis">{children}</h3>,
  h3: ({ children }) => <h4 className="m-0 mt-1 text-body font-semibold text-emphasis">{children}</h4>,
  h4: ({ children }) => <h4 className="m-0 text-body font-semibold text-emphasis">{children}</h4>,
  h5: ({ children }) => <h4 className="m-0 text-body font-semibold text-emphasis">{children}</h4>,
  h6: ({ children }) => <h4 className="m-0 text-body font-semibold text-emphasis">{children}</h4>,
  strong: ({ children }) => <strong className="font-semibold text-emphasis">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del className="text-tertiary">{children}</del>,
  ul: ({ children }) => <ul className="m-0 flex list-disc flex-col gap-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 [&>p]:inline">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="m-0 flex flex-col gap-2 border-l-2 border-rule-strong pl-3 text-secondary">{children}</blockquote>
  ),
  hr: () => <hr className="my-1 border-0 border-t border-rule-structure" />,
  // A fenced block arrives as `pre > code`; the `pre` carries the box and the
  // inner `code` drops the inline chip styling below.
  pre: ({ children }) => <pre className={CODE_BLOCK}>{children}</pre>,
  code: ({ className, children }) => {
    const fenced = typeof className === 'string' && className.startsWith('language-');
    return fenced ? (
      <code className="bg-transparent p-0 font-mono">{children}</code>
    ) : (
      <code className="rounded-xs border border-rule-inner bg-panel px-1 py-px font-mono text-mono-sm text-emphasis [pre_&]:border-0 [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-primary">
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-body-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-card">{children}</thead>,
  th: ({ children, style }) => (
    <th style={style} className="border border-rule-card px-2.5 py-1.5 text-left font-semibold text-emphasis">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-rule-card px-2.5 py-1.5 align-top">
      {children}
    </td>
  ),
  a: ({ children, href }) => (
    <span className="text-accent" title={href}>
      {children}
      {typeof href === 'string' && href !== '' && !childrenIs(children, href) && (
        <span className="font-mono text-mono-sm text-tertiary"> ({href})</span>
      )}
    </span>
  ),
  img: ({ alt }) => <span className="text-tertiary">[image{typeof alt === 'string' && alt !== '' ? `: ${alt}` : ''}]</span>,
};

/** Whether a link's text already is its address, as a bare URL is. */
function childrenIs(children: unknown, href: string): boolean {
  return typeof children === 'string' ? children === href : Array.isArray(children) && children.join('') === href;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex select-text flex-col gap-2.5 text-body text-primary [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
