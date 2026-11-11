const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Kept dependency-free so the article facade script does not pull the catalog. */
export function assertYouTubeId(id: string): string {
  const trimmed = id.trim();
  if (!YOUTUBE_ID.test(trimmed)) {
    throw new Error(`Identificador de YouTube no válido: ${id}`);
  }
  return trimmed;
}

export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${assertYouTubeId(id)}?autoplay=1`;
}

export function youtubePosterUrl(id: string): string {
  return `https://i.ytimg.com/vi/${assertYouTubeId(id)}/hqdefault.jpg`;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube-nocookie.com/watch?v=${assertYouTubeId(id)}`;
}
