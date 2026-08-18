import type { TriviaCategory } from "./types";

export const triviaCategoryOptions: Array<{ value: TriviaCategory; label: string }> = [
  { value: "general-knowledge", label: "General Knowledge" },
  { value: "books", label: "Books" },
  { value: "music", label: "Music" },
  { value: "video-games", label: "Video Games" },
  { value: "board-games", label: "Board Games" },
  { value: "science-nature", label: "Science & Nature" },
  { value: "computers", label: "Computers" },
  { value: "mathematics", label: "Mathematics" },
  { value: "mythology", label: "Mythology" },
  { value: "sports", label: "Sports" },
  { value: "geography", label: "Geography" },
  { value: "history", label: "History" },
  { value: "art", label: "Art" },
  { value: "animals", label: "Animals" },
  { value: "vehicles", label: "Vehicles" }
];
