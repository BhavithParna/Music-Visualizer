declare module 'vader-sentiment' {
  interface Scores { neg: number; neu: number; pos: number; compound: number }
  const vader: { SentimentIntensityAnalyzer: { polarity_scores(text: string): Scores } };
  export default vader;
}
