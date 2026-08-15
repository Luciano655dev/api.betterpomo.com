import type { Response } from "express";

/**
 * Server-side first-pass safety filter for text that can be shown to another
 * BetterPomo user. It intentionally targets unambiguous slurs, sexual content,
 * threats, and self-harm encouragement while leaving ordinary productivity
 * language alone. Reports remain the backstop for context-dependent abuse.
 *
 * Normalization catches common separator and leetspeak evasions. Keep this
 * list deliberately conservative: false positives can prevent someone from
 * saving a legitimate profile or focus session.
 */
function normalizeForModeration(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[7+]/g, "t")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OBJECTIONABLE_PATTERNS: RegExp[] = [
  /\b(?:f+u+c+k+|f+u+k+)\b/,
  /\b(?:c+u+n+t+)\b/,
  /\b(?:n+i+g+g+(?:e+r+|a+))\b/,
  /\b(?:f+a+g+(?:g+o+t+)?)\b/,
  /\b(?:k+i+k+e+)\b/,
  /\b(?:r+e+t+a+r+d+(?:e+d+)?)\b/,
  /\b(?:p+o+r+n+|c+h+i+l+d+\s+p+o+r+n+)\b/,
  /\b(?:r+a+p+e+|r+a+p+i+s+t+)\b/,
  /\b(?:k+i+l+l+\s+(?:y+o+u+r+s+e+l+f+|y+o+u+r+s+e+l+v+e+s+))\b/,
  /\b(?:g+o+\s+d+i+e+|i+\s+w+i+l+l+\s+k+i+l+l+\s+y+o+u+)\b/,
];

function looksLikeSpam(value: string): boolean {
  const links = value.match(/(?:https?:\/\/|www\.)\S+/gi) ?? [];
  if (links.length > 3) return true;
  if (/(.)\1{19,}/u.test(value)) return true;
  return false;
}

export function containsObjectionableContent(value: string): boolean {
  const normalized = normalizeForModeration(value);
  const compact = normalized.replace(/\s+/g, "");
  return OBJECTIONABLE_PATTERNS.some((pattern) => pattern.test(normalized) || pattern.test(compact))
    || looksLikeSpam(value);
}

export function rejectObjectionableText(
  res: Response,
  fields: Array<string | null | undefined>,
): boolean {
  if (!fields.some((value) => typeof value === "string" && containsObjectionableContent(value))) {
    return false;
  }
  res.status(422).json({
    error: "That text contains content that isn't allowed on BetterPomo.",
    code: "objectionable_content",
  });
  return true;
}
