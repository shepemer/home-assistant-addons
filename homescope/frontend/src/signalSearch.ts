import type { Signal } from "./api";

function normalizeSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_.-]+/g, " ")
    .trim();
}

function matchesGlob(value: string, pattern: string) {
  let valueIndex = 0;
  let patternIndex = 0;
  let lastStarIndex = -1;
  let lastStarValueIndex = -1;

  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      valueIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      lastStarIndex = patternIndex;
      lastStarValueIndex = valueIndex;
      patternIndex += 1;
    } else if (lastStarIndex >= 0) {
      patternIndex = lastStarIndex + 1;
      lastStarValueIndex += 1;
      valueIndex = lastStarValueIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
    patternIndex += 1;
  }

  return patternIndex === pattern.length;
}

export function matchesSignalSearch(signal: Signal, rawSearch: string) {
  const search = normalizeSearch(rawSearch);
  if (!search) {
    return true;
  }

  const values = [
    signal.fullName,
    signal.entityId,
    signal.name,
    signal.domain,
    signal.measurement,
    signal.field,
    signal.kind,
    signal.unit,
    signal.group
  ].map(normalizeSearch);

  if (!search.includes("*")) {
    const source = values.join(" ");
    const compactSearch = search.replace(/\s/g, "");
    return source.includes(search) || source.replace(/\s/g, "").includes(compactSearch);
  }

  const candidates = [...values, values.join(" ")];
  const compactSearch = search.replace(/\s/g, "");
  return candidates.some(
    (value) => matchesGlob(value, search) || matchesGlob(value.replace(/\s/g, ""), compactSearch)
  );
}
