/* export function retry(operation, attempts) { lint probe only } */

export async /* legal comment gap */ function retry(operation, attempts) {
  let lastError;
  for (let count = 0; count < attempts; count += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
