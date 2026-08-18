import { lobbyBackgroundValues, triviaCategoryValues, type LobbyBackground, type LobbySettings, type TriviaCategory } from "./types";

export const defaultLobbySettings: LobbySettings = {
  meetingType: "daily-standup",
  title: "",
  team: "",
  prompt: "",
  startTime: "",
  showTrivia: true,
  triviaCategories: ["general-knowledge", "science-nature", "geography", "history"],
  locations: [],
  background: "soft-aurora"
};

export function isLobbyBackground(value: unknown): value is LobbyBackground {
  return typeof value === "string" && lobbyBackgroundValues.includes(value as LobbyBackground);
}

function isTriviaCategory(value: unknown): value is TriviaCategory {
  return typeof value === "string" && triviaCategoryValues.includes(value as TriviaCategory);
}

export function normalizeLobbySettings(value: unknown): LobbySettings {
  const saved = value && typeof value === "object" ? value as Partial<LobbySettings> & { arrivalBuffer?: unknown; presentationUrl?: unknown } : {};
  const { arrivalBuffer: _legacyArrivalBuffer, presentationUrl: _legacyPresentationUrl, ...current } = saved;
  return {
    ...defaultLobbySettings,
    ...current,
    locations: Array.isArray(saved.locations) ? saved.locations : [],
    triviaCategories: Array.isArray(saved.triviaCategories) ? saved.triviaCategories.filter(isTriviaCategory) : defaultLobbySettings.triviaCategories,
    background: isLobbyBackground(saved.background) ? saved.background : defaultLobbySettings.background
  };
}
