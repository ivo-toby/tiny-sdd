export function normalizeTracks(tracks) {
  return tracks.map((track) => ({ id: String(track.id), title: track.title.trim() }));
}

export function appendUnique(tracks, additions) {
  const seen = new Set(tracks.map((track) => String(track.id)));
  const result = [...tracks];
  for (const track of additions) {
    const id = String(track.id);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(track);
  }
  return result;
}
