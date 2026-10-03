export function groupBy(items, keyOf) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof keyOf !== 'function') throw new TypeError('keyOf must be a function');
  const groups = [];
  const byKey = new Map();
  for (const [index, item] of items.entries()) {
    const key = keyOf(item, index);
    let group = byKey.get(key);
    if (group === undefined) {
      group = { key, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups
    .sort((left, right) => String(left.key).localeCompare(String(right.key)))
    .map(({ key, items: members }) => ({ key, items: [...members] }));
}
