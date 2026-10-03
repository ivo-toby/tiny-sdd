export async function settleTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.some((task) => typeof task !== 'function')) {
    throw new TypeError('tasks must be an array of functions');
  }

  const pending = tasks.map((task) => {
    try {
      return Promise.resolve(task()).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      );
    } catch (reason) {
      return Promise.resolve({ status: 'rejected', reason });
    }
  });
  return Promise.all(pending);
}
