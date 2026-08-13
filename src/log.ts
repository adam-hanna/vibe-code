import { appendFileSync } from 'node:fs';

const COLOR = process.stdout.isTTY && !process.env['NO_COLOR'];
const ESC = '\u001b';
const c = (code: string, s: string): string => (COLOR ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const dim = (s: string): string => c('2', s);
export const bold = (s: string): string => c('1', s);
export const green = (s: string): string => c('32', s);
export const yellow = (s: string): string => c('33', s);
export const red = (s: string): string => c('31', s);
export const cyan = (s: string): string => c('36', s);

let transcriptPath: string | null = null;

export function attachTranscript(p: string): void {
  transcriptPath = p;
}

function record(line: string): void {
  if (!transcriptPath) return;
  try {
    appendFileSync(transcriptPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // A broken transcript must never take down a run.
  }
}

export function step(msg: string): void {
  console.log(`${cyan('>')} ${bold(msg)}`);
  record(`STEP  ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${msg}`);
  record(`INFO  ${msg}`);
}

export function detail(msg: string): void {
  console.log(dim(`  ${msg}`));
  record(`DEBUG ${msg}`);
}

export function ok(msg: string): void {
  console.log(`  ${green('OK')} ${msg}`);
  record(`OK    ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${yellow('!')} ${msg}`);
  record(`WARN  ${msg}`);
}

export function fail(msg: string): void {
  console.error(`  ${red('x')} ${msg}`);
  record(`ERROR ${msg}`);
}

export function heading(msg: string): void {
  console.log(`\n${bold(msg)}`);
  record(`\n=== ${msg} ===`);
}
