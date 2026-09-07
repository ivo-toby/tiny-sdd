// Deliberately wrong: UTF-16 code units split astral code points.
export function countCodePoints(text: string): number {
  return [...text].length;
}

export function truncateLabel(text: string, maxPoints: number): string {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 0) throw new RangeError();
  if (text.length <= maxPoints) return text;
  if (maxPoints === 0) return "";
  return text.slice(0, maxPoints - 1) + "…";
}
