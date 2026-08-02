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
      <h2 className="text-base font-semibold text-gray-200 flex items-center gap-2">
        {children}
        {count !== undefined && (
          <span className="text-[12px] font-normal text-gray-500">
            {count} item{count === 1 ? '' : 's'}
          </span>
        )}
      </h2>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
