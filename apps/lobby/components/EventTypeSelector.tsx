import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EVENT_DEFAULTS } from "@/lib/eventDefaults";
import type { ScrumEventType } from "@/types";

const EVENT_ORDER: ScrumEventType[] = [
  "daily-standup",
  "sprint-planning",
  "sprint-review",
  "retrospective",
  "backlog-refinement",
];

interface Props {
  value: ScrumEventType;
  onChange: (v: ScrumEventType) => void;
}

export function EventTypeSelector({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {EVENT_ORDER.map((e) => {
        const def = EVENT_DEFAULTS[e];
        const active = value === e;
        return (
          <button
            key={e}
            type="button"
            onClick={() => onChange(e)}
            className={cn(
              "group rounded-xl border bg-card/60 p-4 text-left transition-all hover:border-primary/60 hover:bg-card",
              active && "border-primary bg-card shadow-[0_0_0_1px_var(--color-primary)]",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">{def.label}</span>
              {active && <Badge className="bg-primary text-primary-foreground">Selected</Badge>}
            </div>
            
          </button>
        );
      })}
    </div>
  );
}
