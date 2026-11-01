/** iOS-style segmented control. */
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-1 gap-[3px] rounded-control border border-line bg-panel-alt p-[3px]">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={`min-h-9 flex-1 cursor-pointer rounded-[calc(var(--radius)-3px)] border-none text-[0.85rem] font-semibold transition-[background,color] duration-150 ease-[ease] ${active ? "bg-panel text-ink-strong shadow-control" : "bg-transparent text-muted shadow-none"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
