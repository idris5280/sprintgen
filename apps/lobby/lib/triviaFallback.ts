export interface TriviaItem {
  question: string;
  answer: string;
  category: string;
}

export const TRIVIA_FALLBACK: TriviaItem[] = [
  { question: "Which planet has the most moons?", answer: "Saturn", category: "Science" },
  { question: "What is the tallest mountain in the solar system?", answer: "Olympus Mons (on Mars)", category: "Science" },
  { question: "In what year did the first Toy Story movie release?", answer: "1995", category: "Film & TV" },
  { question: "What is the smallest country in the world by area?", answer: "Vatican City", category: "Geography" },
  { question: "How many time zones does Russia span?", answer: "11", category: "Geography" },
  { question: "What is the only mammal capable of true flight?", answer: "Bat", category: "Animals" },
  { question: "Bananas grow on what — trees or herbs?", answer: "Herbs (technically the plant is an herb)", category: "Nature" },
  { question: "What is the most spoken language in the world by native speakers?", answer: "Mandarin Chinese", category: "Culture" },
  { question: "Which ocean is the deepest?", answer: "Pacific Ocean", category: "Geography" },
  { question: "What metal is liquid at room temperature?", answer: "Mercury", category: "Science" },
  { question: "How many bones are in the adult human body?", answer: "206", category: "Science" },
  { question: "Who painted the Mona Lisa?", answer: "Leonardo da Vinci", category: "Art" },
  { question: "What is the rarest blood type in humans?", answer: "AB negative", category: "Science" },
  { question: "What sport is known as 'the beautiful game'?", answer: "Soccer (football)", category: "Sports" },
  { question: "What is the hardest natural substance on Earth?", answer: "Diamond", category: "Science" },
];
