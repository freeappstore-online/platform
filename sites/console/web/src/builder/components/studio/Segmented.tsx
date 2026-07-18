/** iOS-style segmented control. */
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex flex-1" style={{ background: "var(--panel-alt)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: 3, gap: 3, minWidth: 0 }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className="flex-1 font-semibold"
            style={{
              minHeight: 36, fontSize: "0.85rem", border: "none", cursor: "pointer",
              borderRadius: "calc(var(--radius) - 3px)",
              background: active ? "var(--panel)" : "transparent",
              color: active ? "var(--ink-strong)" : "var(--muted)",
              boxShadow: active ? "var(--shadow)" : "none",
              transition: "background 0.15s ease, color 0.15s ease",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
