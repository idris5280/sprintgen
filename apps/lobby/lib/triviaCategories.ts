export interface TriviaCategory {
  id: number;
  name: string;
}

/** Curated set of Open Trivia DB categories suitable for a work-meeting lobby. */
export const TRIVIA_CATEGORIES: TriviaCategory[] = [
  { id: 9, name: "General Knowledge" },
  { id: 10, name: "Books" },
  { id: 12, name: "Music" },
  { id: 15, name: "Video Games" },
  { id: 16, name: "Board Games" },
  { id: 17, name: "Science & Nature" },
  { id: 18, name: "Computers" },
  { id: 19, name: "Mathematics" },
  { id: 20, name: "Mythology" },
  { id: 21, name: "Sports" },
  { id: 22, name: "Geography" },
  { id: 23, name: "History" },
  { id: 25, name: "Art" },
  { id: 27, name: "Animals" },
  { id: 28, name: "Vehicles" },
];

export const TRIVIA_CATEGORY_NAMES: Record<number, string> = Object.fromEntries(
  TRIVIA_CATEGORIES.map((c) => [c.id, c.name]),
);

/** Safe, broad defaults — no pop-culture-heavy buckets. */
export const DEFAULT_TRIVIA_CATEGORIES: number[] = [
  9, 10, 12, 17, 20, 21, 22, 23, 27,
];
