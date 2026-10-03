export async function settleTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.some((task) => typeof task !== 'function')) throw new TypeError('tasks must be an array of functions');
  const results = [];
  for (const task of tasks) {
    try {
      const value = await task();
      results.push({ status: 'fulfilled', value });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}
