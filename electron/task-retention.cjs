function removePendingTasksForAnime(tasks, animeId) {
  return tasks.filter((task) => task.animeId !== animeId || task.status !== 'pending');
}

function removeOrphanedPendingTasks(tasks, followedAnimeIds) {
  const followed = new Set(followedAnimeIds);
  return tasks.filter((task) => task.status !== 'pending' || followed.has(task.animeId));
}

module.exports = { removeOrphanedPendingTasks, removePendingTasksForAnime };
