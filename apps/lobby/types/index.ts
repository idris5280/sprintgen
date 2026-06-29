export type ScrumEventType =
  | "daily-standup"
  | "sprint-planning"
  | "sprint-review"
  | "retrospective"
  | "backlog-refinement";

export type MeetingType = "scrum-event" | "knowledge-share";

export interface TeamLocation {
  id: string;
  displayLabel: string;
  weatherLookupCity: string;
  state: string;
  isHQ: boolean;
}

export type MusicMood =
  | "light-upbeat"
  | "focus-creative"
  | "none"
  | "ambient"
  | "low-distraction-focus";

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  ceremonyType: ScrumEventType | "any";
  mood: MusicMood;
  src: string;
  isAvailable: boolean;
}

export type LobbyTheme =
  | "standup-light"
  | "planning-energy"
  | "executive-review"
  | "retro-calm"
  | "focus-mode";

export type MusicSource =
  | { type: "none" }
  | {
      type: "youtube";
      youtubeUrl: string;
      youtubeVideoId: string;
      songTitle: string;
      artist: string;
      videoTitle?: string;
      channelName?: string;
      thumbnailUrl?: string;
    };

export interface LobbyConfig {
  meetingType: MeetingType;
  eventType: ScrumEventType;
  meetingTitle: string;
  /** Knowledge Share: subject of the session. */
  ksSubjectTitle?: string;
  /** Knowledge Share: name of the presenter. */
  ksPresenter?: string;
  teamName?: string;
  sprintName?: string;
  facilitationPrompt?: string;
  /** Legacy fallback (minutes). Prefer scheduledStartTime. */
  countdownMinutes: number;
  /** Local clock time "HH:mm" (24h) for today's meeting. */
  scheduledStartTime: string;
  /** Optional ISO date "YYYY-MM-DD" — defaults to today when omitted. */
  scheduledStartDate?: string;
  /** Friendly buffer after start time before "ready" state. */
  arrivalBufferSeconds: number;
  selectedTheme: LobbyTheme;
  teamLocations: TeamLocation[];
  musicSource: MusicSource;
  /** Optional Azure DevOps board URL for the handoff screen. */
  azureDevOpsBoardUrl?: string;
  /** Optional generated Sprint Review presentation URL for the handoff screen. */
  presentationHandoffUrl?: string;
  /** Show rotating trivia questions during pre-meeting wait. */
  triviaEnabled?: boolean;
  /** Enabled Open Trivia DB category IDs. Empty array = use local fallback only. */
  triviaCategories?: number[];
}

export interface WeatherInfo {
  locationId: string;
  temperature: number;
  condition: string;
  high: number;
  low: number;
  icon: string;
}
