export type ReviewSource = "manual" | "ado";
export type SectionType =
  | "delivery"
  | "screenshot"
  | "challenge"
  | "risk"
  | "next_steps"
  | "live_demo"
  | "agile_metrics"
  | "burndown"
  | "velocity";

export interface Story {
  id: string | number;
  title: string;
  type?: string;
  state?: string;
  storyPoints?: number;
  areaPath?: string;
}

export interface ReviewSection {
  id: string;
  type: SectionType;
  title: string;
  bodyText?: string;
  businessValue?: string;
  priority?: boolean;
  stories?: Story[];
  imageData?: string;
  imageName?: string;
  mediaRef?: string;
  description?: string;
  impact?: "low" | "medium" | "high";
  likelihood?: "low" | "medium" | "high";
  roam?: "resolved" | "owned" | "accepted" | "mitigated";
  owner?: string;
  notes?: string;
  enabled?: boolean;
  presenters?: string[];
  note?: string;
}

export interface Narrative {
  summary: string;
  openingTitle: string;
  openingSubtitle: string;
  sections: ReviewSection[];
  teamLogo: { imageData?: string; imageName?: string; mediaRef?: string };
  metricSectionsConfigured: boolean;
  environmentReadiness: {
    training: { enabled: boolean; message: string; stories: Story[] };
    uat: { enabled: boolean; message: string; stories: Story[] };
  };
}

export interface Review {
  id: string;
  source: ReviewSource;
  status: "draft" | "ready";
  ownerId: string;
  creatorName: string;
  createdAt: string;
  updatedAt: string;
  generatedAt?: string;
  team: string;
  sprintName: string;
  sprintPath: string;
  areaPaths: string[];
  dateRange: { startDate: string; finishDate: string };
  presentation?: { color?: string };
  result: {
    source: ReviewSource;
    team: string;
    areaPaths: string[];
    iteration: { name: string; path: string; startDate: string; finishDate: string };
    workItems?: { items: Story[] };
    metrics?: Record<string, unknown>;
    warnings?: string[];
  };
  nextWorkItems?: { items: Story[] };
  narrative: Narrative;
}

export interface ReviewRecord {
  review: Review;
  etag: string;
}

export interface ReviewFormValues {
  identity: { team: string; sprint: string; startDate: string; finishDate: string };
  narrative: Narrative;
}

export interface LobbyLocation {
  id: string;
  city: string;
}

export const lobbyBackgroundValues = [
  "particles",
  "soft-aurora",
  "molten-metal"
] as const;

export type LobbyBackground = (typeof lobbyBackgroundValues)[number];

export const triviaCategoryValues = [
  "general-knowledge",
  "books",
  "music",
  "video-games",
  "board-games",
  "science-nature",
  "computers",
  "mathematics",
  "mythology",
  "sports",
  "geography",
  "history",
  "art",
  "animals",
  "vehicles"
] as const;

export type TriviaCategory = (typeof triviaCategoryValues)[number];

export interface TriviaQuestion {
  question: string;
  answer: string;
  category: string;
}

export interface LobbySettings {
  meetingType: "daily-standup" | "sprint-planning" | "sprint-review" | "retrospective" | "backlog-refinement" | "knowledge-share";
  title: string;
  team: string;
  prompt: string;
  startTime: string;
  showTrivia: boolean;
  triviaCategories: TriviaCategory[];
  locations: LobbyLocation[];
  background: LobbyBackground;
}
