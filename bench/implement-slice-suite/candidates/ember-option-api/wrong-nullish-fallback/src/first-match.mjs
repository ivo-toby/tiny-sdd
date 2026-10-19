import { Option } from './option.mjs';

export function firstMatching(values, predicate) {
  const found = values.map((value) => predicate(value) ? Option.some(value) : Option.none())
    .find((option) => option.isSome);
  return found?.val ?? null;
}
