export type FileMention = {
  start: number;
  end: number;
  query: string;
};

export const fileMentionAtCursor = (text: string, cursor: number): FileMention | null => {
  const position = Math.max(0, Math.min(cursor, text.length));
  const beforeCursor = text.slice(0, position);
  const match = beforeCursor.match(/(?:^|[\s([{])@([^\s@]*)$/);
  if (!match) return null;
  const start = beforeCursor.lastIndexOf("@");
  return start < 0 ? null : { start, end: position, query: match[1] ?? "" };
};

export const removeFileMention = (text: string, mention: FileMention) => {
  const before = text.slice(0, mention.start);
  let after = text.slice(mention.end);
  if (/\s$/.test(before) && /^\s/.test(after)) after = after.slice(1);
  return { text: `${before}${after}`, cursor: before.length };
};
