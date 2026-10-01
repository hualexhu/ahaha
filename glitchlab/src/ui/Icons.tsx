import type { ReactNode, SVGProps } from 'react';

/** Small stroke icon set (24-unit grid, drawn for GlitchLab). */
const paths: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  up: <path d="M6 15l6-6 6 6" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" />
    </>
  ),
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="9" r="1.1" fill="currentColor" /><circle cx="15" cy="15" r="1.1" fill="currentColor" />
      <circle cx="15" cy="9" r="1.1" fill="currentColor" /><circle cx="9" cy="15" r="1.1" fill="currentColor" />
    </>
  ),
  split: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M12 3v18" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  crop: <path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14" />,
  download: <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14" />,
  upload: <path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5M5 20h14" />,
  more: <><circle cx="5.5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="18.5" cy="12" r="1.3" fill="currentColor" /></>,
  diamond: <path d="M12 4l7 8-7 8-7-8z" />,
  film: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="M20.5 16l-5-5-8.5 8.5" /></>,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  archive: <><rect x="3.5" y="4" width="17" height="5" rx="1.5" /><path d="M5 9v9.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V9M10 13h4" /></>,
  text: <path d="M5 6h14M12 6v13M9 19h6" />,
  save: <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" />,
  trash: <path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4.5M12 17.2v.3" /></>,
  sliders: <path d="M5 7h9M18 7h1M5 17h3M12 17h7M14 4.5v5M8 14.5v5" />,
  // effect glyphs
  geometry: <path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14" />,
  colour: <><circle cx="9" cy="10" r="5" /><circle cx="15" cy="10" r="5" /><circle cx="12" cy="15" r="5" /></>,
  datamosh: <path d="M3 8c3 0 3 4 6 4s3-4 6-4 3 4 6 4M3 16c3 0 3-3 6-3s3 3 6 3 3-3 6-3" />,
  databend: <><path d="M4 5h7v5H4zM13 5h7v3h-7zM4 12h4v7H4zM10 12h10v3H10zM10 17h6v2h-6z" /></>,
  pixelsort: <path d="M5 19V9M9 19V5M13 19v-7M17 19V8M21 19v-4M3 19h19" />,
  eightbit: <path d="M4 4h5v5H4zM9 9h6v6H9zM15 4h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z" />,
  palette: <><path d="M12 3.5a8.5 8.5 0 100 17c1.4 0 1.8-1 1.4-2-.5-1.3.2-2.5 1.8-2.5H18a3.5 3.5 0 003.5-3.5c0-5-4.2-9-9.5-9z" /><circle cx="7.8" cy="11" r="1" fill="currentColor" /><circle cx="10.5" cy="7.3" r="1" fill="currentColor" /><circle cx="15" cy="7.8" r="1" fill="currentColor" /></>,
  ascii: <path d="M4 18l3.5-12L11 18M5.2 14h4.6M14 8h6M14 12h6M14 16h4" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...rest }: { name: string; size?: number } & SVGProps<SVGSVGElement>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {paths[name] ?? null}
    </svg>
  );
}
