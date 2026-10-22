import React from 'react';

const paths = {
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6M14 10v6" />
    </>
  ),
  comment: (
    <>
      <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-5 3v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="M7 8h10M7 12h6" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  focus: (
    <>
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 6 6 6-6 6m9 0h7" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  undo: <path d="m8 4-4 4 4 4M4 8h10a6 6 0 0 1 0 12h-3" />,
  diff: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M9 9h6m-3-3v6m-3 4h6" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6m0 4h.01" />
    </>
  ),
  spinner: <path d="M20 12a8 8 0 1 1-8-8" />,
  plus: <path d="M12 5v14M5 12h14" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5H4v11h4" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  settings: (
    <>
      <path d="m10 3-.7 2-2 .9-2-.4-2 3.5 1.4 1.6v2.4L3.3 15l2 3.5 2-.4 2 .9.7 2h4l.7-2 2-.9 2 .4 2-3.5-1.4-1.6V11l1.4-1.6-2-3.5-2 .4-2-.9-.7-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6v18h12V7Z" />
      <path d="M14 3v5h4" />
    </>
  ),
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m20 16-4.5-4.5L7 19" />
    </>
  ),
  send: <path d="M12 20V4m-6 6 6-6 6 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  bulb: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" />
    </>
  ),
  hook: <path d="M7 4v9a5 5 0 0 0 10 0v-2M14 14l3-3 3 3" />,
  plug: (
    <>
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8Z" />
      <path d="M12 16v5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="19" r="2" />
      <path d="M6 7v10M18 8c0 6-12 2-12 8" />
    </>
  ),
  back: <path d="m15 6-6 6 6 6" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />,
  at: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  bookmark: <path d="M6 21V4h12v17l-6-4Z" />,
  code: (
    <>
      <path d="M5 3h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-6l-5 3v-3a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" />
      <path d="M21 8h1v11a2 2 0 0 1-2 2h-4v2l-4-2H9" />
      <path d="m8 8-2 2 2 2m6-4 2 2-2 2m-3-5-1 6" />
    </>
  ),
};
export function Icon({ name, className = '' }: { name: keyof typeof paths; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
