Add `appendUnique(tracks, additions)` to `src/playlist.mjs`.

Return a fresh array containing the original tracks followed by additions whose
string ids have not already appeared. Preserve order, keep the first instance
of each id, and do not mutate either input array. Preserve the existing
`normalizeTracks` export and behavior.
