export async function settleTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.some((task) => typeof task !== 'function')) throw new TypeError('tasks must be an array of functions');
  const results = [];
  await Promise.all(tasks.map((task) => {
    try {
      return Promise.resolve(task()).then(
        (value) => { results.push({ status: 'fulfilled', value }); },
        (reason) => { results.push({ status: 'rejected', reason }); },
      );
    } catch (reason) {
      results.push({ status: 'rejected', reason });
      return undefined;
    }
  }));
  return results;
}
