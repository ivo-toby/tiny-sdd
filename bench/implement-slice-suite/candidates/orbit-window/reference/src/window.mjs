export function buildWindows(length, width) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('length must be a non-negative integer');
  if (!Number.isInteger(width) || width < 1) throw new RangeError('width must be a positive integer');
  const windows = [];
  for (let start = 0; start < length; start += width) {
    windows.push({ start, end: Math.min(length, start + width) });
  }
  return windows;
}
