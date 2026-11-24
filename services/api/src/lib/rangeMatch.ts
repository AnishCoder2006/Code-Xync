/**
 * Locate the AI's target range (the function's original lines) in the live document.
 * A plain substring match is not enough: text appended to the last line of the function
 * ("return a - b  # edited") still contains the original as a substring, so the stale
 * check passed and Accept overwrote code the AI never saw. A match only counts when it
 * covers whole lines: before it on its line only indentation, after it a line end or EOF.
 *
 * Same logic in services/sync/src/rangeMatch.ts (separate package); keep them equal.
 */
export function wholeLineOccurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const lineStart = text.lastIndexOf("\n", i - 1) + 1;
    const before = text.slice(lineStart, i);
    const end = i + needle.length;
    const after = text[end];
    const endsLine = end === text.length || after === "\n" || (after === "\r" && text[end + 1] === "\n") || needle.endsWith("\n");
    if (/^[ \t]*$/.test(before) && endsLine) out.push(i);
  }
  return out;
}
