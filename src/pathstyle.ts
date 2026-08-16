/**
 * Path conventions differ per *agent*, not per operating system.
 *
 * Verified on one Windows 11 machine: Claude Code executes Bash tool calls in
 * Git Bash (MINGW64, `/c/...`) while Codex executes them in PowerShell
 * (`C:\...`). Both at the same time, on the same host. Anything keyed on
 * `process.platform` is therefore wrong by construction - the style belongs to
 * the runtime, which is why it is probed rather than inferred.
 */
export type PathStyle = 'win32' | 'msys' | 'cygwin' | 'wsl' | 'posix';

/** Mount prefix each POSIX-flavoured style uses for a Windows drive. */
const DRIVE_MOUNT: Readonly<Record<'msys' | 'cygwin' | 'wsl', string>> = {
  msys: '/',
  cygwin: '/cygdrive/',
  wsl: '/mnt/',
};

const WIN32_ABS = /^([A-Za-z]):[\\/](.*)$/;

/**
 * PATH entry separator. Windows shells use `;`; everything else uses `:`.
 * Keyed on style rather than host because the agent's shell decides, not us.
 */
export function pathListSeparator(style: PathStyle): ';' | ':' {
  return style === 'win32' ? ';' : ':';
}

/**
 * Translate a host-native absolute path into the form the agent's shell reads.
 *
 * Paths that are already in the target form pass through, so this is safe to
 * apply more than once - prompt text is assembled from many sources and
 * double-translation is otherwise an easy bug to introduce.
 */
export function toAgentPath(hostPath: string, style: PathStyle): string {
  if (style === 'win32') return toWin32(hostPath);
  if (style === 'posix') return hostPath.replace(/\\/g, '/');

  const already = fromAgentPath(hostPath, style);
  const win = WIN32_ABS.exec(already);
  if (!win?.[1] || win[2] === undefined) return hostPath.replace(/\\/g, '/');

  const drive = win[1].toLowerCase();
  const rest = win[2].replace(/\\/g, '/');
  return `${DRIVE_MOUNT[style]}${drive}/${rest}`;
}

/**
 * Translate a path reported *by* the agent back to host-native form.
 *
 * Needed as often as the forward direction: findings, file lists and diffs come
 * back in the agent's convention and vibe has to open those files itself.
 */
export function fromAgentPath(agentPath: string, style: PathStyle): string {
  if (style === 'posix') return agentPath;
  if (style === 'win32') return toWin32(agentPath);

  const mount = DRIVE_MOUNT[style];
  const escaped = mount.replace(/[/]/g, '\\/');
  const re = new RegExp(`^${escaped}([A-Za-z])(?:/(.*))?$`);
  const m = re.exec(agentPath);
  if (!m?.[1]) return agentPath;

  const drive = m[1].toUpperCase();
  const rest = (m[2] ?? '').replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

function toWin32(p: string): string {
  for (const style of ['cygwin', 'wsl', 'msys'] as const) {
    const mount = DRIVE_MOUNT[style];
    const escaped = mount.replace(/[/]/g, '\\/');
    const m = new RegExp(`^${escaped}([A-Za-z])(?:/(.*))?$`).exec(p);
    // `msys` mounts at `/` and would match any absolute POSIX path whose first
    // segment is a single letter, so it is tried last and only after the
    // longer, unambiguous prefixes have been ruled out.
    if (m?.[1]) return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`;
  }
  return p.replace(/\//g, '\\');
}

export interface PathStyleFacts {
  platform: 'windows' | 'darwin' | 'linux';
  shell: string;
  /** `$MSYSTEM`, set by Git Bash / MSYS2. Absent under Cygwin proper. */
  msystem?: string | undefined;
  /** The shell's own `pwd`. The most direct evidence available. */
  cwdSample?: string | undefined;
  /** Sample of the agent's PATH. Last resort - see below. */
  pathSample?: string | undefined;
}

/**
 * Classify a runtime from probe facts.
 *
 * Evidence is ranked by how directly it reflects the shell's own convention.
 * `pwd` wins because the shell prints it in the form it actually uses. PATH is
 * ranked last and only consulted when nothing better exists: the machine that
 * motivated this module has a *hybrid* PATH - MSYS-style leading entries plus
 * `/cygdrive/` Windows entries that MINGW64 cannot resolve - so a PATH sample
 * containing `/cygdrive/` is evidence of a broken PATH, not of a Cygwin shell.
 * An earlier version ranked PATH first and misclassified that host as `cygwin`
 * while its working paths were plainly `/c/...`.
 */
export function detectPathStyle(facts: PathStyleFacts): PathStyle {
  const { platform, shell, msystem, cwdSample, pathSample } = facts;
  if (platform !== 'windows') return 'posix';

  const lower = shell.toLowerCase();
  if (lower.includes('powershell') || lower.includes('pwsh') || lower.includes('cmd')) {
    return 'win32';
  }

  if (cwdSample?.startsWith('/cygdrive/')) return 'cygwin';
  if (cwdSample?.startsWith('/mnt/')) return 'wsl';
  if (/^\/[A-Za-z]\//.test(cwdSample ?? '')) return 'msys';

  if (msystem) return 'msys';
  if (pathSample?.includes('/cygdrive/')) return 'cygwin';
  if (pathSample?.includes('/mnt/c/')) return 'wsl';
  return 'msys';
}
