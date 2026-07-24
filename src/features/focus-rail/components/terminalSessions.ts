export type TerminalSessionState = {
  sessionIds: string[];
  activeSessionId: string;
};

export const advanceTerminalOutputSequence = (
  renderedSequence: number,
  incomingSequence: number,
) => incomingSequence > renderedSequence ? incomingSequence : null;

export const normalizeTerminalSessions = (
  sessionIds: readonly string[],
  activeSessionId: string | undefined,
): TerminalSessionState => {
  const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
  const normalizedIds = uniqueIds.length ? uniqueIds : [crypto.randomUUID()];
  return {
    sessionIds: normalizedIds,
    activeSessionId: activeSessionId && normalizedIds.includes(activeSessionId)
      ? activeSessionId
      : normalizedIds[0],
  };
};

export const addTerminalSession = (
  sessionIds: readonly string[],
  sessionId: string = crypto.randomUUID(),
): TerminalSessionState => ({
  sessionIds: [...sessionIds, sessionId],
  activeSessionId: sessionId,
});

export const removeTerminalSession = (
  sessionIds: readonly string[],
  activeSessionId: string,
  sessionId: string,
): TerminalSessionState => {
  const remaining = sessionIds.filter((id) => id !== sessionId);
  if (!remaining.length) return normalizeTerminalSessions([], undefined);
  return {
    sessionIds: remaining,
    activeSessionId: activeSessionId === sessionId ? remaining.at(-1)! : activeSessionId,
  };
};

export const restartTerminalSession = (
  sessionIds: readonly string[],
  activeSessionId: string,
  sessionId: string,
  replacementSessionId: string = crypto.randomUUID(),
): TerminalSessionState => ({
  sessionIds: sessionIds.map((id) => id === sessionId ? replacementSessionId : id),
  activeSessionId: activeSessionId === sessionId ? replacementSessionId : activeSessionId,
});

export const cleanupLateTerminalStart = async (
  disposed: boolean,
  sessionId: string,
  stopTerminal: (sessionId: string) => Promise<void>,
) => {
  if (!disposed) return false;
  await stopTerminal(sessionId).catch(() => undefined);
  return true;
};
