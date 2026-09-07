// Deliberately wrong: appended ellipsis exceeds the requested budget.
export function countCodePoints(text: string): number {
  return [...text].length;
}

export function truncateLabel(text: string, maxPoints: number): string {
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 0) throw new RangeError();
  const points = [...text];
  if (points.length <= maxPoints) return text;
  if (maxPoints === 0) return "";
  return points.slice(0, maxPoints).join("") + "…";
}
