// Port of `simulation_engine/llm_json_parser.py`.
//
// Convex-free on purpose, like scoring.ts — the conformance harness imports it.
//
// This file exists because the first pass of this project parsed model output with
// `JSON.parse(text.slice(text.indexOf('{')))`, which is wrong in three ways that
// upstream had already solved:
//
//   1. no curly-quote normalization — a model emitting “smart quotes” breaks it
//   2. no brace counting — ANY prose after the closing brace ("Here's the JSON:
//      {...}  Let me know if...") makes JSON.parse throw
//   3. it throws instead of returning null, so one malformed response kills a turn
//
// (2) is the common case. Models append trailing commentary constantly.
//
// Note also that upstream does NOT parse categorical/numerical responses as JSON
// at all — it scrapes them with regex, deliberately, so a structurally broken
// response still yields answers. That robustness is the point, and it is why
// these are ported rather than reinvented.

/**
 * Port of `extract_first_json_dict` (llm_json_parser.py:5).
 * Also duplicated verbatim at global_methods.py:240 upstream — identical.
 *
 * Returns null on failure, matching upstream's `except ValueError: return None`.
 */
export function extractFirstJsonDict(inputStr: string): Record<string, unknown> | null {
  try {
    // Curly quotes -> straight. Models produce these when the prompt contains
    // prose, and they are not valid JSON.
    const normalized = inputStr
      .replaceAll('“', '"')
      .replaceAll('”', '"')
      .replaceAll('‘', "'")
      .replaceAll('’', "'");

    const startIndex = normalized.indexOf('{');
    if (startIndex === -1) return null; // Python's .index() raises; caller returns None

    // Brace-count to the matching close. This is what makes trailing prose
    // harmless — we take exactly the first balanced object and nothing after it.
    let count = 1;
    let endIndex = startIndex + 1;
    while (count > 0 && endIndex < normalized.length) {
      if (normalized[endIndex] === '{') count += 1;
      else if (normalized[endIndex] === '}') count -= 1;
      endIndex += 1;
    }

    return JSON.parse(normalized.slice(startIndex, endIndex));
  } catch {
    return null;
  }
}

/**
 * Port of `extract_first_json_dict_categorical` (llm_json_parser.py:40).
 *
 * Regex, NOT JSON parsing — deliberately. The categorical template asks for a
 * large nested object per question ("Option Interpretation", "Option Choice",
 * "Reasoning", "Response"); scraping the two fields we need survives a response
 * that is truncated or structurally malformed, which a JSON parse would not.
 *
 * `findall` returns matches in document order, so for a batch of N questions the
 * Nth response corresponds to the Nth question.
 */
export function extractCategorical(inputStr: string): {
  responses: string[];
  reasonings: string[];
} {
  // Faithful to upstream's `[^"]+`: one-or-more non-quote chars. This does not
  // handle escaped quotes inside a value, and does not match empty strings.
  // Preserved rather than "fixed" — changing it changes which answers parse.
  const reasoningPattern = /"Reasoning":\s*"([^"]+)"/g;
  const responsePattern = /"Response":\s*"([^"]+)"/g;

  return {
    responses: [...inputStr.matchAll(responsePattern)].map((m) => m[1]),
    reasonings: [...inputStr.matchAll(reasoningPattern)].map((m) => m[1]),
  };
}

/**
 * Port of `extract_first_json_dict_numerical` (llm_json_parser.py:50).
 *
 * Note the difference from categorical: `"Response":\s*(\d+\.?\d*)` matches an
 * UNQUOTED number. The numerical template asks for a bare value, so treating the
 * two response kinds identically silently fails on one of them.
 */
export function extractNumerical(inputStr: string): {
  responses: string[];
  reasonings: string[];
} {
  const reasoningPattern = /"Reasoning":\s*"([^"]+)"/g;
  const responsePattern = /"Response":\s*(\d+\.?\d*)/g;

  return {
    responses: [...inputStr.matchAll(responsePattern)].map((m) => m[1]),
    reasonings: [...inputStr.matchAll(reasoningPattern)].map((m) => m[1]),
  };
}

/**
 * Importance scores from the importance template.
 *
 * Upstream: `list(gpt_response.values())` over the parsed dict — positional, so
 * key naming ("Item  1", note the double space) doesn't matter, only order.
 * Upstream's fail-safe is 25.
 */
export function extractImportanceScores(inputStr: string, expected: number): number[] {
  const parsed = extractFirstJsonDict(inputStr);
  if (!parsed) return new Array(expected).fill(25);

  const values = Object.values(parsed).map((v) => Number(v));
  if (values.length !== expected || values.some((v) => Number.isNaN(v))) {
    return new Array(expected).fill(25);
  }
  return values;
}

/** Reflections come back as `{"reflection": [...]}`. Upstream fail-safe is []. */
export function extractReflections(inputStr: string): string[] {
  const parsed = extractFirstJsonDict(inputStr);
  const list = parsed?.reflection;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];
}

/** Utterances come back as `{"utterance": "..."}`. */
export function extractUtterance(inputStr: string): string | null {
  const parsed = extractFirstJsonDict(inputStr);
  const utterance = parsed?.utterance;
  return typeof utterance === 'string' ? utterance : null;
}
