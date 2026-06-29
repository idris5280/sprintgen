import { THEME_OPTIONS } from "@/lib/eventDefaults";
import { cn } from "@/lib/utils";
import type { LobbyTheme } from "@/types";

interface Props {
  value: LobbyTheme;
  onChange: (v: LobbyTheme) => void;
}

export function ThemeSelector({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {THEME_OPTIONS.map((t) => {
        const active = value === t.value;
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            className={cn(
              "relative h-20 overflow-hidden rounded-xl border text-left transition-all",
              `theme-${t.value}`,
              active ? "border-primary ring-2 ring-primary/40" : "border-border/60 hover:border-primary/50",
            )}
          >
            <div className="absolute inset-0 bg-black/30" />
            <span className="absolute bottom-2 left-3 text-xs font-semibold text-white">
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
