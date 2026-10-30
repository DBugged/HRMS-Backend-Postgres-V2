// Purpose: how much of the variable pay a performance rating earns.
// Responsibilities: the fixed 1-5 -> payout % table; every rating saved or approved takes its payout from here.
// Important: 1 is the lowest rating and earns none, 5 the highest and earns all. A payout sent with a rating is not used,
//   so the two can never disagree (a 1/5 used to be saved with 100%).
export const RATING_PAYOUT: Record<number, number> = {
  1: 0,
  2: 25,
  3: 50,
  4: 75,
  5: 100,
};

export function payoutForRating(rating: number): number {
  return RATING_PAYOUT[rating] ?? 0;
}
