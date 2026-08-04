import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EventTypeSelector } from "./EventTypeSelector";
import { ThemeSelector } from "./ThemeSelector";
import { EVENT_DEFAULTS, STORAGE_KEY } from "@/lib/eventDefaults";
import {
  TRIVIA_CATEGORIES,
  DEFAULT_TRIVIA_CATEGORIES,
} from "@/lib/triviaCategories";
import type { LobbyConfig, ScrumEventType, TeamLocation } from "@/types";
import { Play, Eye } from "lucide-react";

interface Props {
  config: LobbyConfig;
  setConfig: (c: LobbyConfig) => void;
}

const LOCATION_EXAMPLES = [
  "e.g. Nashville, TN",
  "e.g. Detroit, MI",
  "e.g. Las Vegas, NV",
  "e.g. Oklahoma City, OK",
];

export function SetupForm({ config, setConfig }: Props) {
  const update = (patch: Partial<LobbyConfig>) => setConfig({ ...config, ...patch });

  const handleEventChange = (eventType: ScrumEventType) => {
    const def = EVENT_DEFAULTS[eventType];
    update({
      eventType,
      selectedTheme: def.theme,
    });
  };

  const handleMeetingTypeChange = (mt: "scrum-event" | "knowledge-share") => {
    if (mt === config.meetingType) return;
    update({ meetingType: mt });
    return;
    if (mt === "knowledge-share") {
      update({
        meetingType: "knowledge-share",
        meetingTitle: config.ksSubjectTitle?.trim() || "Knowledge Share",
        facilitationPrompt: "Settle in — we'll begin shortly.",
      });
    } else {
      const def = EVENT_DEFAULTS[config.eventType];
      update({
        meetingType: "scrum-event",
        meetingTitle: def.label,
        facilitationPrompt: def.prompt,
      });
    }
  };

  const handleLocationChange = (id: string, patch: Partial<TeamLocation>) => {
    update({
      teamLocations: config.teamLocations.map((l) =>
        l.id === id ? { ...l, ...patch } : l,
      ),
    });
  };

  const hqLocation = config.teamLocations.find((loc) => loc.isHQ);

  const persistAndGo = () => {
    const next: LobbyConfig = { ...config, musicSource: { type: "none" } };
    setConfig(next);
    // Save synchronously so /lobby/run reads the latest config.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    window.location.assign("/lobby/run");
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <header className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-medium uppercase tracking-[0.3em] text-primary">
            Scrum Studio / Lobby
          </div>
          <Button variant="secondary" size="sm" asChild>
            <a href="/">Home</a>
          </Button>
        </div>
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">
          Set the tone before your next scrum event.
        </h1>
        <p className="text-base text-muted-foreground">
          Configure a screen-shareable lobby with a countdown, team weather, and trivia.
        </p>
      </header>

      <section className="space-y-3">
        <Label className="text-sm font-semibold">Meeting Type</Label>
        <div className="grid grid-cols-2 gap-3">
          {[
            { v: "scrum-event" as const, label: "Scrum Event", desc: "Daily standup, planning, review, retro, refinement" },
            { v: "knowledge-share" as const, label: "Knowledge Share", desc: "ITS knowledge share for a large audience" },
          ].map((opt) => {
            const active = config.meetingType === opt.v;
            return (
              <button
                key={opt.v}
                type="button"
                onClick={() => handleMeetingTypeChange(opt.v)}
                className={`rounded-xl border bg-card/60 p-4 text-left transition-all hover:border-primary/60 hover:bg-card ${
                  active ? "border-primary bg-card shadow-[0_0_0_1px_var(--color-primary)]" : ""
                }`}
              >
                <div className="text-sm font-semibold text-foreground">{opt.label}</div>
                <p className="mt-1 text-xs text-muted-foreground">{opt.desc}</p>
              </button>
            );
          })}
        </div>
      </section>

      {config.meetingType === "scrum-event" && (
        <section className="space-y-3">
          <Label className="text-sm font-semibold">Scrum event</Label>
          <EventTypeSelector value={config.eventType} onChange={handleEventChange} />
        </section>
      )}

      {config.meetingType === "knowledge-share" && (
        <section className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="ksSubject">Subject title</Label>
            <Input
              id="ksSubject"
              value={config.ksSubjectTitle ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                update({
                  ksSubjectTitle: v,
                });
              }}
              placeholder="e.g. Intro to our new observability stack"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ksPresenter">Presenter</Label>
            <Input
              id="ksPresenter"
              value={config.ksPresenter ?? ""}
              onChange={(e) => update({ ksPresenter: e.target.value })}
              placeholder="e.g. Jordan Smith"
            />
          </div>
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        {config.meetingType !== "knowledge-share" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="meetingTitle">Meeting title</Label>
              <Input
                id="meetingTitle"
                value={config.meetingTitle ?? ""}
                onChange={(e) => update({ meetingTitle: e.target.value })}
                placeholder="e.g. Daily Standup"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="teamName">Team name</Label>
              <Input
                id="teamName"
                value={config.teamName ?? ""}
                onChange={(e) => update({ teamName: e.target.value })}
                placeholder="e.g. Team 7"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sprintName">Sprint name (optional)</Label>
              <Input
                id="sprintName"
                value={config.sprintName ?? ""}
                onChange={(e) => update({ sprintName: e.target.value })}
                placeholder="e.g. Sprint 24"
              />
            </div>
          </>
        )}
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="prompt">Facilitation prompt</Label>
          <Textarea
            id="prompt"
            rows={2}
            value={config.facilitationPrompt ?? ""}
            onChange={(e) => update({ facilitationPrompt: e.target.value })}
            placeholder="e.g. What changed since yesterday?"
          />
        </div>
        <div className="md:col-span-2 space-y-3 rounded-xl border bg-card/60 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="triviaEnabled" className="text-sm font-medium">
                Show trivia during pre-meeting
              </Label>
              <p className="text-xs text-muted-foreground">
                Light, non-work trivia rotates while people arrive. The facilitation prompt
                still shows during the arrival buffer. Turn off to leave the area blank.
              </p>
            </div>
            <Switch
              id="triviaEnabled"
              checked={config.triviaEnabled !== false}
              onCheckedChange={(v: boolean) => update({ triviaEnabled: v })}
            />
          </div>

          {config.triviaEnabled !== false && (() => {
            const selected = config.triviaCategories ?? DEFAULT_TRIVIA_CATEGORIES;
            const selectedSet = new Set(selected);
            const toggleCat = (id: number) => {
              const next = selectedSet.has(id)
                ? selected.filter((c) => c !== id)
                : [...selected, id];
              update({ triviaCategories: next });
            };
            return (
              <div className="space-y-2 border-t border-border/60 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Categories
                  </Label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        update({
                          triviaCategories: TRIVIA_CATEGORIES.map((c) => c.id),
                        })
                      }
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => update({ triviaCategories: [] })}
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TRIVIA_CATEGORIES.map((cat) => {
                    const on = selectedSet.has(cat.id);
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => toggleCat(cat.id)}
                        className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                          on
                            ? "border-primary/50 bg-primary/15 text-foreground"
                            : "border-border/60 bg-transparent text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {cat.name}
                      </button>
                    );
                  })}
                </div>
                {selected.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No categories selected - a small built-in set of fallback questions will be used.
                  </p>
                )}
              </div>
            );
          })()}
        </div>
        {config.meetingType !== "knowledge-share" && (
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="azureUrl">Azure DevOps board URL</Label>
            <Input
              id="azureUrl"
              type="url"
              value={config.azureDevOpsBoardUrl ?? ""}
              onChange={(e) => update({ azureDevOpsBoardUrl: e.target.value })}
              placeholder="https://dev.azure.com/org/project/_boards/board/..."
            />
            <p className="text-xs text-muted-foreground">
              Optional. Add your team board link so the lobby can hand off cleanly.
            </p>
          </div>
        )}
        {config.meetingType !== "knowledge-share" && config.eventType === "sprint-review" && (
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="presentationHandoffUrl">Presentation handoff URL</Label>
            <Input
              id="presentationHandoffUrl"
              value={config.presentationHandoffUrl ?? ""}
              onChange={(e) => update({ presentationHandoffUrl: e.target.value })}
              placeholder="/ado-present/<job-id>?vibe=prismatic or saved HTML link"
            />
            <p className="text-xs text-muted-foreground">
              Optional. Paste the generated Sprint Review presentation link after using Build.
            </p>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="startTime">Meeting start time (optional)</Label>
          <Input
            id="startTime"
            type="time"
            value={config.scheduledStartTime ?? ""}
            onChange={(e) => update({ scheduledStartTime: e.target.value })}
          />
          {!config.scheduledStartTime?.trim() && (
            <p className="text-xs text-muted-foreground">
              Leave blank to open the lobby with a 5-minute countdown.
            </p>
          )}
          {(() => {
            if (!config.scheduledStartTime?.trim()) {
              return null;
            }
            const [h, m] = config.scheduledStartTime.split(":");
            const d = new Date();
            d.setHours(Number(h) || 0, Number(m) || 0, 0, 0);
            if (d.getTime() < Date.now()) {
              return (
                <p className="text-xs text-amber-500">
                  This time has already passed today. The lobby will start in arrival mode.
                </p>
              );
            }
            return null;
          })()}
        </div>
        <div className="space-y-2">
          <Label htmlFor="arrivalBuffer">Arrival buffer</Label>
          <Select
            value={String(config.arrivalBufferSeconds)}
            onValueChange={(v) => update({ arrivalBufferSeconds: Number(v) })}
          >
            <SelectTrigger id="arrivalBuffer">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">0 seconds</SelectItem>
              <SelectItem value="30">30 seconds</SelectItem>
              <SelectItem value="60">60 seconds</SelectItem>
              <SelectItem value="90">90 seconds</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            After the scheduled start time, Lobby can show a short welcoming buffer while everyone settles in.
          </p>
        </div>
      </section>

      {config.meetingType === "knowledge-share" ? (
        <section className="space-y-3">
          <Label className="text-sm font-semibold">Team locations</Label>
          {hqLocation ? (
            <div className="rounded-xl border bg-card/60 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  Optional HQ weather
                </span>
                <Badge className="bg-primary text-primary-foreground">HQ</Badge>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Weather lookup city</Label>
                <Input
                  value={hqLocation.weatherLookupCity}
                  onChange={(e) =>
                    handleLocationChange(hqLocation.id, {
                      displayLabel: "",
                      weatherLookupCity: e.target.value,
                    })
                  }
                  placeholder={LOCATION_EXAMPLES[3]}
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                The lobby uses this city as the card label. Leave it blank to hide weather.
              </p>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="space-y-3">
          <Label className="text-sm font-semibold">Team locations</Label>
          <p className="text-xs text-muted-foreground">
            Add only the locations you want shown. Rows with no weather lookup city are hidden in the lobby.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {config.teamLocations.map((loc, index) => (
              <div key={loc.id} className="rounded-xl border bg-card/60 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider text-muted-foreground">
                    {loc.isHQ ? "HQ location" : `Location ${index + 1}`}
                  </span>
                  {loc.isHQ && (
                    <Badge className="bg-primary text-primary-foreground">HQ</Badge>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Weather lookup city</Label>
                  <Input
                    value={loc.weatherLookupCity}
                    onChange={(e) =>
                      handleLocationChange(loc.id, {
                        displayLabel: "",
                        weatherLookupCity: e.target.value,
                      })
                    }
                    placeholder={LOCATION_EXAMPLES[index] ?? "e.g. Chicago, IL"}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <Label className="text-sm font-semibold">Theme</Label>
        <ThemeSelector
          value={config.selectedTheme}
          onChange={(v) => update({ selectedTheme: v })}
        />
      </section>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Button size="lg" onClick={persistAndGo}>
          <Play className="mr-2 h-4 w-4" /> Launch Lobby
        </Button>
        <Button size="lg" variant="secondary" onClick={persistAndGo}>
          <Eye className="mr-2 h-4 w-4" /> Preview Lobby
        </Button>
      </div>
    </div>
  );
}
