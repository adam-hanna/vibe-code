import type { CSSProperties } from 'react';

const paths = {
  plus: 'M12 5v14M5 12h14',
  search: 'm21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16',
  spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3',
  improve: 'M4 19V5m0 14h16M8 14l4-5 4 3 4-7m-5 0h5v5',
  bug: 'M9 3h6m-3 0v3m-4 2-3-3m11 3 3-3M4 12h3m10 0h3M5 19l3-3m8 0 3 3M7 10a5 5 0 0 1 10 0v5a5 5 0 0 1-10 0v-5m5-3v13',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7',
  chevron: 'm9 5 7 7-7 7',
  send: 'M12 19V5m-6 6 6-6 6 6',
  check: 'm5 12 4 4L19 6',
  loop: 'M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5',
  pause: 'M7 5v14M17 5v14',
  stop: 'M6 6h12v12H6z',
  activity: 'M3 12h4l2-7 4 14 2-7h6',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  info: 'M12 11v5m0-9h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
} as const;

export function Icon({ name, size = 18, style }: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>
    <path d={paths[name]} />
  </svg>;
}

/** The same mark at window and welcome sizes; it is artwork, never a run measurement. */
export function VibeMark({ large = false }: { large?: boolean }) {
  return <span
    className={`inline-flex flex-none items-center justify-center bg-accent text-page ${large ? 'size-11 rounded-[14px]' : 'size-8 rounded-[10px]'}`}
    aria-hidden="true"
  >
    <svg viewBox="0 0 40 40" fill="none" className="size-full">
      <path d="M10 12 20 29 30 12M15 12l5 9 5-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>;
}
