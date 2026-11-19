// Small shared pieces: icons, URL state, disclosure, size hook.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';

const ICONS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  reset: (
    <>
      <path d="M4 9V4M4 4h5M20 15v5M20 20h-5" />
      <path d="M4 4l6 6M20 20l-6-6" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  swap: <path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" />,
  compare: <path d="M9 4v16M15 4v16M4 8h5M4 16h5M15 8h5M15 16h5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  play: <path d="M8 5.5v13l11-6.5z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  sort: <path d="M8 5v14M8 19l-3-3M8 5l3 3M16 19V5M16 5l-3 3M16 19l3-3" />,
  feedback: <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8.5L6 19.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 9.5h8M8 12.5h5" />,
};
export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="sf-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

// App state lives in the URL so any view can be shared. `set` merges a patch; null or '' removes a key.
export type Patch = Record<string, string | null>;
export function useUrl() {
  const [sp, setSp] = useSearchParams();
  const set = useCallback(
    (patch: Patch, replace = false) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace },
      );
    },
    [setSp],
  );
  const href = useCallback(
    (patch: Patch, keep: string[] = ['example', 'hideSidebar']) => {
      const next = new URLSearchParams();
      for (const k of keep) {
        const v = sp.get(k);
        if (v !== null) next.set(k, v);
      }
      for (const [k, v] of Object.entries(patch)) if (v) next.set(k, v);
      return `?${next.toString()}`;
    },
    [sp],
  );
  return { sp, set, href };
}

// A link that changes URL state without a page load, and still works as a real link (new tab, copy address)
export function StateLink({ to, className, children, onNavigate, ...rest }: { to: string; className?: string; children: ReactNode; onNavigate?: () => void } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const [, setSp] = useSearchParams();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        setSp(new URLSearchParams(to.slice(1)));
        onNavigate?.();
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="sf-disclosure">
      <summary>
        <Icon name="chevron" size={14} />
        {summary}
      </summary>
      <div className="sf-disclosure-body">{children}</div>
    </details>
  );
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    fn();
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [query]);
  return on;
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { key: T; label: string }[]; label: string }) {
  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === value);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = tabs[(i + d + tabs.length) % tabs.length];
    onChange(next.key);
    (e.currentTarget.querySelector(`[data-tab="${next.key}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="sf-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" data-tab={t.key} aria-selected={t.key === value} tabIndex={t.key === value ? 0 : -1} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// A number whose changing characters roll: the old one slides out and the new one slides in, up when the number
// rises and down when it falls. Characters that stay the same stay still, so going from 2022 to 2023, or 22% to 21%,
// moves only the last digit. Characters are matched from the right, where the ones place is, so 9% to 10% lines up.
// Screen readers get the plain text.
const firstNumber = (t: string) => {
  const m = t.match(/\d[\d,]*\.?\d*/);
  return m ? Number(m[0].replace(/,/g, '')) : NaN;
};
export function RollNumber({ value }: { value: string }) {
  const [cur, setCur] = useState(value);
  const [gen, setGen] = useState(0);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const [ghosts, setGhosts] = useState<Record<number, string>>({}); // by place from the right: 0 is the last character
  const [keys, setKeys] = useState<Record<number, string>>({});
  if (value !== cur) {
    const out: Record<number, string> = {};
    const k = { ...keys };
    const n = value.length;
    for (let j = 0; j < n; j++) {
      const old = cur[cur.length - 1 - j];
      if (old !== value[n - 1 - j]) {
        out[j] = old ?? '';
        k[j] = `${j}-${gen + 1}`; // a new key remounts that character, which restarts its animation
      }
    }
    const was = firstNumber(cur);
    const now = firstNumber(value);
    setCur(value);
    setDir(now >= was || Number.isNaN(now) || Number.isNaN(was) ? 'up' : 'down');
    setGen(gen + 1);
    setGhosts(out);
    setKeys(k);
  }
  useEffect(() => {
    if (!Object.keys(ghosts).length) return;
    const t = window.setTimeout(() => setGhosts({}), 800); // longer than the slowest roll (the KPI figures), so none is cut short
    return () => window.clearTimeout(t);
  }, [ghosts]);
  return (
    <span className="sf-rollnum" data-dir={dir}>
      <span className="sf-sr">{value}</span>
      <span className="sf-rolldigits" aria-hidden="true">
        {value.split('').map((ch, i) => {
          const j = value.length - 1 - i;
          return (
            <span className="sf-rolldigit" key={keys[j] ?? `${j}-0`}>
              {ghosts[j] ? <span className="sf-rolldigit-out">{ghosts[j]}</span> : null}
              <span className={j in ghosts ? 'sf-rolldigit-in' : undefined}>{ch}</span>
            </span>
          );
        })}
      </span>
    </span>
  );
}

// Where the pointer is inside an element, in that element's own CSS pixels (not on-screen pixels).
// The interface is drawn with the CSS zoom property. Under it, getBoundingClientRect reports on-screen pixels while layout sizes,
// and everything drawn from them, are in zoomed pixels. The ratio of the two is the zoom, so dividing by it puts the pointer back
// in the space the page is laid out in. With no zoom the ratio is 1 and nothing changes.
export function localPoint(e: { clientX: number; clientY: number }, el: Element, layoutW: number, layoutH: number) {
  const r = el.getBoundingClientRect();
  const sx = r.width && layoutW ? layoutW / r.width : 1;
  const sy = r.height && layoutH ? layoutH / r.height : 1;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}
