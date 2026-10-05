export function createEvents() {
  const events = [];
  return {
    add(type, value) {
      events.push({ type, value });
    },
    snapshot() {
      return events.map((event) => ({ ...event }));
    },
  };
}
