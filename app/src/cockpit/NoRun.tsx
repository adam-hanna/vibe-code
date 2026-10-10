import { Badge } from '@/ui/badge';
import { EMPTY } from './pane';

/**
 * A pane with no run behind it (#319).
 *
 * Plans has always said this in its own words. Code, Verify and Spend did not,
 * and while a new run was being talked through with the pilot they drew the
 * window's last live run instead - a run the draft has nothing to do with,
 * beside a column correctly saying the run had not begun. The sentence is the
 * pane's own, because what it reads is what tells you when it will fill.
 */
export function NoRun({ children }: { children: string }) {
  return (
    <div className={EMPTY}>
      <Badge>no run</Badge>
      <p className="m-0 max-w-md">{children}</p>
    </div>
  );
}
