export function normalizeTracks(tracks) {
  return tracks.map((track) => ({ id: String(track.id), title: track.title.trim() }));
}

export function appendUnique(tracks, additions) {
  for (const track of additions) {
    if (!tracks.some((entry) => entry.id === track.id)) tracks.push(track);
  }
  return tracks;
}
