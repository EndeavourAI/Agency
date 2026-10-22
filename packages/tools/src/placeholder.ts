const PHRASE =
  /^(?:\/\/|#|--|\/\*|<!--|\()?\s*(?:\.\.\.|…)?\s*(?:rest of(?: the)?(?: (?:code|file|methods?|functions?|class|implementation))?|(?:unchanged|existing|remaining|previous) (?:code|methods?|functions?|lines|content|implementation))\s*(?:\.\.\.|…)?\.*\s*(?:\*\/|-->|\))?$/i;

/**
 * A line that stands for code the model left out (`// ... rest of code ...`): written to a file, it deletes that
 * code. The first such line of `text` that `before` does not have (Gemini CLI `omissionPlaceholderDetector`).
 */
export function newPlaceholder(text: string, before = ""): string | undefined {
  const had = new Set(before.split(/\r?\n/).map((line) => line.trim()));
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\.\.\.|…/.test(line) && PHRASE.test(line) && !had.has(line));
}
