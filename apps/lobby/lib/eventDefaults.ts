import type {
  LobbyConfig,
  LobbyTheme,
  MusicMood,
  MusicTrack,
  ScrumEventType,
  TeamLocation,
} from "@/types";
import { DEFAULT_TRIVIA_CATEGORIES } from "./triviaCategories";

export const DEFAULT_TEAM_LOCATIONS: TeamLocation[] = [
  {
    id: "nashville",
    displayLabel: "",
    weatherLookupCity: "",
    state: "",
    isHQ: false,
  },
  {
    id: "michigan",
    displayLabel: "",
    weatherLookupCity: "",
    state: "",
    isHQ: false,
  },
  {
    id: "las-vegas",
    displayLabel: "",
    weatherLookupCity: "",
    state: "",
    isHQ: false,
  },
  {
    id: "hq-oklahoma",
    displayLabel: "",
    weatherLookupCity: "",
    state: "",
    isHQ: true,
  },
];

export interface EventDefaults {
  label: string;
  theme: LobbyTheme;
  mood: MusicMood;
  prompt: string;
  description: string;
}

export const EVENT_DEFAULTS: Record<ScrumEventType, EventDefaults> = {
  "daily-standup": {
    label: "Daily Standup",
    theme: "standup-light",
    mood: "light-upbeat",
    prompt: "What changed since yesterday?",
    description: "Clean, fast, minimal",
  },
  "sprint-planning": {
    label: "Sprint Planning",
    theme: "planning-energy",
    mood: "focus-creative",
    prompt: "What outcome matters most this sprint?",
    description: "Energetic, creative",
  },
  "sprint-review": {
    label: "Sprint Review",
    theme: "executive-review",
    mood: "none",
    prompt: "What did we deliver?",
    description: "Polished, stakeholder-ready",
  },
  retrospective: {
    label: "Retrospective",
    theme: "retro-calm",
    mood: "ambient",
    prompt: "What should we start, stop, or continue?",
    description: "Soft, reflective, safe",
  },
  "backlog-refinement": {
    label: "Backlog Refinement",
    theme: "focus-mode",
    mood: "low-distraction-focus",
    prompt: "What needs clarity before planning?",
    description: "Focused, low-distraction",
  },
};

export const THEME_OPTIONS: { value: LobbyTheme; label: string }[] = [
  { value: "standup-light", label: "Light" },
  { value: "planning-energy", label: "Energy" },
  { value: "executive-review", label: "Executive" },
  { value: "retro-calm", label: "Calm" },
  { value: "focus-mode", label: "Focus" },
];

export const SEEDED_TRACKS: MusicTrack[] = [
  {
    id: "track-standup-1",
    title: "Morning Momentum",
    artist: "Tidewave",
    ceremonyType: "daily-standup",
    mood: "light-upbeat",
    src: "",
    isAvailable: false,
  },
  {
    id: "track-planning-1",
    title: "Blueprint",
    artist: "North Loop",
    ceremonyType: "sprint-planning",
    mood: "focus-creative",
    src: "",
    isAvailable: false,
  },
  {
    id: "track-review-1",
    title: "Quiet Wins",
    artist: "Halcyon",
    ceremonyType: "sprint-review",
    mood: "none",
    src: "",
    isAvailable: false,
  },
  {
    id: "track-retro-1",
    title: "Soft Horizons",
    artist: "Kestrel",
    ceremonyType: "retrospective",
    mood: "ambient",
    src: "",
    isAvailable: false,
  },
  {
    id: "track-refinement-1",
    title: "Deep Channel",
    artist: "Atlas Field",
    ceremonyType: "backlog-refinement",
    mood: "low-distraction-focus",
    src: "",
    isAvailable: false,
  },
];

export const DEFAULT_CONFIG: LobbyConfig = {
  meetingType: "scrum-event",
  eventType: "daily-standup",
  meetingTitle: "",
  teamName: "",
  sprintName: "",
  facilitationPrompt: "",
  countdownMinutes: 5,
  scheduledStartTime: "",
  arrivalBufferSeconds: 30,
  selectedTheme: EVENT_DEFAULTS["daily-standup"].theme,
  musicSource: { type: "none" },
  teamLocations: DEFAULT_TEAM_LOCATIONS,
  azureDevOpsBoardUrl: "",
  presentationHandoffUrl: "",
  triviaEnabled: true,
  triviaCategories: DEFAULT_TRIVIA_CATEGORIES,
};

export const STORAGE_KEY = "scrum-studio-lobby-config-v2";
export const LEGACY_STORAGE_KEYS = [
  "scrum-studio-lobby-config-v1",
  "scrum-lobby-config-v3",
];
