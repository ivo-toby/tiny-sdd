export async function settleTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.some((task) => typeof task !== 'function')) throw new TypeError('tasks must be an array of functions');
  return Promise.all(tasks.map((task) => task()));
}
