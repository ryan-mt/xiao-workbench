/** OpenAI-style reasoning: first `**Title**` block is disclosure metadata. */
export function reasoningSummary(text: string): { title: string | null; body: string } {
  const content = text.trim();
  if (!content) return { title: null, body: "" };
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/);
  if (!match) return { title: null, body: content };
  return { title: match[1].trim(), body: content.slice(match[0].length).trimEnd() };
}

export function formatThoughtDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

/** Label for thought-titled execution groups — never freeform reasoning prose. */
export function thoughtTraceTitle(body?: string): string {
  const title = body ? reasoningSummary(body).title : null;
  return title ? `Thought: ${title}` : "Thought";
}
