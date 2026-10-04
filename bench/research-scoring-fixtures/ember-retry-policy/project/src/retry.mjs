export async function retry(operation, retries = 0, delay = async () => {}) {
  let attempt = 0;
  while (true) {
    try {
      return await operation(attempt++);
    } catch (error) {
      if (attempt > retries) throw error;
      await delay(attempt);
    }
  }
}
