/**
 * Shared helpers for managing `<!-- skill:<id> -->` blocks inside an
 * agent's prompt. Used by both the skill attach/detach route and the
 * `toApiAgent` mapper so there's one canonical implementation of the
 * marker format.
 */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append a per-skill block to the prompt. Idempotent on skill_id — if a
 * block for this skill already exists, the prompt is returned unchanged.
 */
export function appendSkillBlock(
  prompt: string | null | undefined,
  skillId: string,
  skillContent: string,
): string {
  const current = (prompt ?? "").trimEnd();
  const markerRe = new RegExp(`(^|\\n)<!-- skill:${escapeRegex(skillId)} -->\\n`);
  if (markerRe.test(current)) {
    return current;
  }
  const block = `<!-- skill:${skillId} -->\n${skillContent.trim()}`;
  return current ? `${current}\n\n${block}` : block;
}

/** Strip a single skill block (matching skill_id) from the prompt. */
export function stripSkillBlock(
  prompt: string | null | undefined,
  skillId: string,
): string {
  const current = prompt ?? "";
  // `\n*` (not `\n?`) eats any number of leading blank lines before the
  // marker, and `\n+` in the lookahead handles multi-blank-line spacing
  // between blocks. The final `.replace(/^\n+/, "")` is a
  // belt-and-suspenders cleanup for the case where the stripped block
  // was at position 0 of the prompt.
  const re = new RegExp(
    `\\n*<!-- skill:${escapeRegex(skillId)} -->\\n[\\s\\S]*?(?=\\n+<!-- skill:|$)`,
  );
  return current.replace(re, "").replace(/^\n+/, "").trimEnd();
}

/**
 * Strip every skill block from the prompt. Covers both the new
 * per-id marker (`<!-- skill:<id> -->`) and the legacy anonymous
 * `<!-- skill -->` marker used by earlier versions of the skill route.
 */
export function stripAllSkillBlocks(prompt: string | null | undefined): string {
  const current = prompt ?? "";
  // Legacy anonymous marker — everything after it was the single skill.
  const legacySplit = current.split(/\n<!-- skill -->\n/)[0];
  // New per-id markers — strip every block.
  return legacySplit
    .replace(/\n*<!-- skill:[^\s>]+ -->\n[\s\S]*?(?=\n+<!-- skill:|$)/g, "")
    .replace(/^\n+/, "")
    .trimEnd();
}

/** Parse the prompt and return attached skill_ids in marker order. */
export function parseAttachedSkillIds(prompt: string | null | undefined): string[] {
  const current = prompt ?? "";
  const ids: string[] = [];
  const re = /<!-- skill:([^\s>]+) -->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(current)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}
