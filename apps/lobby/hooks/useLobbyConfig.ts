import { useEffect, useState } from "react";
import {
  DEFAULT_CONFIG,
  DEFAULT_TEAM_LOCATIONS,
  EVENT_DEFAULTS,
  LEGACY_STORAGE_KEYS,
  STORAGE_KEY,
} from "@/lib/eventDefaults";
import type { LobbyConfig, TeamLocation } from "@/types";

const LEGACY_SAMPLE_LOCATIONS: Record<string, Pick<TeamLocation, "displayLabel" | "weatherLookupCity" | "state">> = {
  nashville: {
    displayLabel: "Nashville",
    weatherLookupCity: "Nashville, TN",
    state: "TN",
  },
  michigan: {
    displayLabel: "Michigan",
    weatherLookupCity: "Detroit, MI",
    state: "MI",
  },
  "las-vegas": {
    displayLabel: "Las Vegas",
    weatherLookupCity: "Las Vegas, NV",
    state: "NV",
  },
  "hq-oklahoma": {
    displayLabel: "Oklahoma",
    weatherLookupCity: "Oklahoma City, OK",
    state: "OK",
  },
};

function findStoredConfig(): { raw: string; isLegacy: boolean } | null {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current) {
    return { raw: current, isLegacy: false };
  }

  for (const key of LEGACY_STORAGE_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw) {
      return { raw, isLegacy: true };
    }
  }

  return null;
}

function isLegacyEventDefaultText(value: unknown, kind: "label" | "prompt") {
  return Object.values(EVENT_DEFAULTS).some((def) => value === def[kind]);
}

function normalizeLocations(
  locations: Partial<TeamLocation>[] | undefined,
  clearLegacySamples: boolean,
): TeamLocation[] {
  return DEFAULT_TEAM_LOCATIONS.map((base, index) => {
    const stored =
      locations?.find((loc) => loc.id === base.id) ?? locations?.[index] ?? {};
    const next: TeamLocation = { ...base, ...stored };
    const legacySample = LEGACY_SAMPLE_LOCATIONS[next.id];

    if (
      clearLegacySamples &&
      legacySample &&
      next.displayLabel === legacySample.displayLabel &&
      next.weatherLookupCity === legacySample.weatherLookupCity
    ) {
      return {
        ...next,
        displayLabel: "",
        weatherLookupCity: "",
        state: "",
      };
    }

    return next;
  });
}

function hydrateConfig(parsed: Partial<LobbyConfig>, isLegacy: boolean): LobbyConfig {
  const next: LobbyConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    musicSource: { type: "none" },
    teamLocations: normalizeLocations(parsed.teamLocations, isLegacy),
  };

  if (isLegacy) {
    if (next.teamName === "Team 7") {
      next.teamName = "";
    }
    if (next.sprintName === "Sprint 24") {
      next.sprintName = "";
    }
    if (
      next.meetingTitle === "Knowledge Share" ||
      isLegacyEventDefaultText(next.meetingTitle, "label")
    ) {
      next.meetingTitle = "";
    }
    if (
      next.facilitationPrompt === "Settle in - we'll begin shortly." ||
      next.facilitationPrompt === "Settle in \u2014 we'll begin shortly." ||
      isLegacyEventDefaultText(next.facilitationPrompt, "prompt")
    ) {
      next.facilitationPrompt = "";
    }
    if (next.scheduledStartTime === "09:45") {
      next.scheduledStartTime = "";
    }
  }

  return next;
}

export function useLobbyConfig() {
  const [config, setConfig] = useState<LobbyConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const stored = findStoredConfig();
      if (stored) {
        const parsed = JSON.parse(stored.raw) as Partial<LobbyConfig>;
        setConfig(hydrateConfig(parsed, stored.isLegacy));
      }
    } catch {
      /* ignore */
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* ignore */
    }
  }, [config, loaded]);

  return { config, setConfig, loaded };
}
