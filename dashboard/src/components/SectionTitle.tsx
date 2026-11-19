/**
 * The one way a screen titles itself.
 *
 * Before this there were five: text-base semibold gray-200, text-sm medium gray-200, uppercase
 * tracking-wide gray-400, semibold white, and uppercase gray-300. Nobody chose that — each
 * screen was written at a different time and copied whatever was nearest, which is how a
 * hand-maintained style drifts exactly like a hand-maintained type.
 *
 * A component rather than a shared class string, because a class string is still something each
 * screen has to remember to paste. `count` is here because three screens had already invented
 * their own "· N items" suffix in three different shapes.
 */
export function SectionTitle({ children, count, actions }: {
  children: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h2 className="font-display text-xl font-semibold text-gray-100 flex items-center gap-2">
        {children}
        {count !== undefined && (
          <span className="font-sans text-[12px] font-normal text-gray-400">
            {count} item{count === 1 ? '' : 's'}
          </span>
        )}
      </h2>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/** The small uppercase label over a group ("ACTIVE RUNS · 2", "TEMPLATES · 21"). */
export function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[12px] uppercase tracking-[0.12em] text-gray-400 ${className}`}>{children}</div>
  );
}

/**
 * The Night Glass segmented meter — the glowing "Loading…" bar from the design references.
 * Lit cells glow in the accent, unlit cells are outlines, all sitting in a dark well.
 * `pct` is 0–100; `cells` how many segments; `height` each cell's height in px.
 */
export function SegMeter({ pct, cells = 30, height = 20, label, className = '' }: {
  pct: number;
  cells?: number;
  height?: number;
  label?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const lit = Math.round((cells * clamped) / 100);
  return (
    <div
      role="img"
      aria-label={label ?? `${Math.round(clamped)} percent`}
      className={`flex gap-[3px] p-[5px] rounded-md shadow-[0_0_16px_rgba(59,139,255,0.3)] ${className}`}
      style={{ background: 'rgba(4,8,20,0.9)' }}
    >
      {Array.from({ length: cells }, (_, i) => (
        <span
          key={i}
          className={`flex-1 rounded-[2px] ${i < lit ? 'seg-on' : 'seg-off'}`}
          style={{ height }}
        />
      ))}
    </div>
  );
}
