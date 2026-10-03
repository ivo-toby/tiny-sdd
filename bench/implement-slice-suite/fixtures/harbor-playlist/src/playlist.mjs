export function normalizeTracks(tracks) {
  return tracks.map((track) => ({ id: String(track.id), title: track.title.trim() }));
}

export function appendUnique(tracks, additions) {
  return [...tracks, ...additions];
}
