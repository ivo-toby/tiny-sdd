export function countCodePoints(text: string): number {
  return [...text].length;
}

export function truncateLabel(_text: string, _maxPoints: number): string {
  throw new Error("Not implemented");
}
