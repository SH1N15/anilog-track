export function removePendingTasksForAnime<T extends { animeId: number; status: string }>(
  tasks: T[],
  animeId: number,
): T[];

export function removeOrphanedPendingTasks<T extends { animeId: number; status: string }>(
  tasks: T[],
  followedAnimeIds: Iterable<number>,
): T[];
