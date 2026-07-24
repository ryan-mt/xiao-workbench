import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { isTauriHost, nativeBridge } from "../../../core/bridges/tauri";
import type { SystemInfo, WorkspaceSnapshot } from "../../../core/models/workspace";
import {
  addTerminalSession,
  advanceTerminalOutputSequence,
  normalizeTerminalSessions,
  removeTerminalSession,
  type TerminalSessionState,
} from "./terminalSessions";

type TerminalPanelProps = {
  active: boolean;
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  system: SystemInfo;
  transitioning: boolean;
  initialSessionIds?: string[];
  initialActiveSessionId?: string;
  initialSessionNames?: Record<string, string>;
  onSessionStateChange?: (state: TerminalSessionState) => void;
  onSessionNamesChange?: (names: Record<string, string>) => void;
};

type TerminalOutput = { sessionId: string; data: string; sequence: number };
type TerminalExit = { sessionId: string; exitCode: number | null; error: string | null };
type TerminalStatus = "error" | "exited" | "ready" | "starting";

const readTerminalTheme = (): ITheme => {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  return {
    background: token("--code-surface"),
    foreground: token("--text-soft"),
    cursor: token("--success"),
    cursorAccent: token("--code-surface"),
    selectionBackground: token("--surface-strong"),
    black: token("--text"),
    red: token("--danger"),
    green: token("--success"),
    yellow: "#a87627",
    blue: token("--info"),
    magenta: "#8f6abb",
    cyan: "#3a8e91",
    white: token("--text-soft"),
    brightBlack: token("--muted"),
    brightRed: token("--danger"),
    brightGreen: token("--success"),
    brightYellow: "#c4933e",
    brightBlue: token("--info"),
    brightMagenta: "#aa84cf",
    brightCyan: "#58aaad",
    brightWhite: token("--text"),
  };
};

const shellName = (shell: string) => shell.split(/[\\/]/).filter(Boolean).at(-1) ?? shell;

type TerminalSessionProps = Omit<
  TerminalPanelProps,
  "initialSessionIds" | "initialActiveSessionId" | "initialSessionNames" |
  "onSessionStateChange" | "onSessionNamesChange"
> & {
  sessionId: string;
  sessionNumber: number;
};

function TerminalSession({
  active,
  workspace,
  taskId,
  system,
  transitioning,
  sessionId,
  sessionNumber,
}: TerminalSessionProps) {
  const [restartKey, setRestartKey] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const fitTerminal = () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    if (!terminal || !fitAddon || !host || host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fitAddon.fit();
      const sessionId = sessionIdRef.current;
      if (sessionId && terminal.cols > 0 && terminal.rows > 0) {
        void nativeBridge.resizeTerminal(sessionId, terminal.cols, terminal.rows).catch(() => undefined);
      }
    } catch {
      // The next resize or tab activation will retry once the host has dimensions.
    }
  };

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      fitTerminal();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (transitioning) {
      setStatus("exited");
      setError("Terminal paused while the task execution root changes.");
      return;
    }

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 11,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: readTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setStatus("starting");
    setError(null);

    let disposed = false;
    let outputUnlisten: UnlistenFn | null = null;
    let exitUnlisten: UnlistenFn | null = null;
    let terminalStarted = false;
    let renderedSequence = 0;
    const pendingOutput: TerminalOutput[] = [];
    sessionIdRef.current = sessionId;

    const dataSubscription = terminal.onData((data) => {
      const activeSessionId = sessionIdRef.current;
      if (!activeSessionId) return;
      void nativeBridge.writeTerminal(activeSessionId, data).catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      });
    });
    const resizeObserver = new ResizeObserver(() => fitTerminal());
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-palette"],
    });

    const start = async () => {
      if (!isTauriHost()) {
        setStatus("error");
        setError("Interactive terminal is available in the Xiao desktop app.");
        return;
      }
      try {
        const removeOutputListener = await listen<TerminalOutput>("terminal://output", (event) => {
          if (event.payload.sessionId !== sessionId) return;
          if (!terminalStarted) {
            pendingOutput.push(event.payload);
            return;
          }
          const nextSequence = advanceTerminalOutputSequence(
            renderedSequence,
            event.payload.sequence,
          );
          if (nextSequence === null) return;
          renderedSequence = nextSequence;
          terminal.write(event.payload.data);
        });
        if (disposed) {
          removeOutputListener();
          return;
        }
        outputUnlisten = removeOutputListener;
        const removeExitListener = await listen<TerminalExit>("terminal://exit", (event) => {
          if (event.payload.sessionId !== sessionId || disposed) return;
          sessionIdRef.current = null;
          if (event.payload.error) {
            setError(event.payload.error);
            setStatus("error");
          } else {
            setStatus("exited");
            terminal.writeln(`\r\n\x1b[2m[process exited ${event.payload.exitCode ?? ""}]\x1b[0m`);
          }
        });
        if (disposed) {
          removeExitListener();
          return;
        }
        exitUnlisten = removeExitListener;
        const proposed = fitAddon.proposeDimensions();
        const started = await nativeBridge.startTerminal(
          sessionId,
          workspace.path,
          taskId,
          system.shell,
          proposed?.cols ?? 100,
          proposed?.rows ?? 30,
        );
        if (disposed) return;
        terminal.write(started.replay);
        renderedSequence = started.replaySequence;
        for (const output of pendingOutput) {
          const nextSequence = advanceTerminalOutputSequence(renderedSequence, output.sequence);
          if (nextSequence === null) continue;
          renderedSequence = nextSequence;
          terminal.write(output.data);
        }
        terminalStarted = true;
        setStatus("ready");
        fitTerminal();
        if (active) terminal.focus();
      } catch (reason) {
        if (disposed) return;
        sessionIdRef.current = null;
        void nativeBridge.stopTerminal(sessionId).catch(() => undefined);
        const message = reason instanceof Error ? reason.message : String(reason);
        setError(message);
        setStatus("error");
        terminal.writeln(`\x1b[31m${message}\x1b[0m`);
      }
    };
    void start();

    return () => {
      disposed = true;
      sessionIdRef.current = null;
      outputUnlisten?.();
      exitUnlisten?.();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    restartKey,
    sessionId,
    system.shell,
    taskId,
    transitioning,
    workspace.execution.executionRoot,
    workspace.path,
  ]);

  return (
    <section className="shell-workspace shell-workspace--pty">
      <header className="shell-workspace__header">
        <div className="shell-workspace__lights"><i /><i /><i /></div>
        <div><strong>{workspace.name} · Terminal {sessionNumber}</strong><small>{shellName(system.shell)}</small></div>
        <div className="shell-workspace__actions">
          <span className={`shell-workspace__status is-${status}`}><i />{status}</span>
          <button type="button" disabled={transitioning} onClick={() => terminalRef.current?.clear()}>Clear</button>
          <button type="button" disabled={transitioning} title="Restart terminal" onClick={() => {
            void nativeBridge.stopTerminal(sessionId).finally(() => setRestartKey((key) => key + 1));
          }}>
            <XiaoIcon name="refresh" size={12} />
          </button>
        </div>
      </header>
      <div className="shell-workspace__path" title={workspace.execution.executionRoot}>
        <XiaoIcon name="folderOpen" size={12} />
        <span>{workspace.execution.executionRoot}</span>
      </div>
      <div className="shell-terminal" ref={hostRef} onMouseDown={() => terminalRef.current?.focus()} />
      <footer>
        <span>Interactive PTY · {shellName(system.shell)}</span>
        <span>{error ?? "Ctrl+C to interrupt · scrollback 10k"}</span>
      </footer>
    </section>
  );
}

export function TerminalPanel({
  active,
  workspace,
  taskId,
  system,
  transitioning,
  initialSessionIds = [],
  initialActiveSessionId,
  initialSessionNames = {},
  onSessionStateChange = () => {},
  onSessionNamesChange = () => {},
}: TerminalPanelProps) {
  const [sessions, setSessions] = useState(() =>
    normalizeTerminalSessions(initialSessionIds, initialActiveSessionId)
  );
  const [sessionNames, setSessionNames] = useState<Record<string, string>>(initialSessionNames);
  const publishedInitialSession = useRef(initialSessionIds.length > 0);

  useEffect(() => {
    if (publishedInitialSession.current) return;
    publishedInitialSession.current = true;
    onSessionStateChange(sessions);
  }, [onSessionStateChange, sessions]);

  const updateSessions = (next: TerminalSessionState) => {
    setSessions(next);
    onSessionStateChange(next);
  };

  return (
    <div className="task-terminal-sessions">
      <nav className="task-terminal-sessions__tabs" aria-label="Task terminal sessions">
        {sessions.sessionIds.map((sessionId, index) => (
          <span
            className={sessionId === sessions.activeSessionId ? "is-active" : undefined}
            key={sessionId}
          >
            <button
              type="button"
              aria-current={sessionId === sessions.activeSessionId ? "page" : undefined}
              onClick={() => updateSessions({
                ...sessions,
                activeSessionId: sessionId,
              })}
            >
              {sessionNames[sessionId] ?? `Terminal ${index + 1}`}
            </button>
            <button
              type="button"
              aria-label={`Rename Terminal ${index + 1}`}
              onClick={() => {
                const name = window.prompt(
                  "Terminal name",
                  sessionNames[sessionId] ?? `Terminal ${index + 1}`,
                )?.trim();
                if (!name) return;
                const next = { ...sessionNames, [sessionId]: name.slice(0, 80) };
                setSessionNames(next);
                onSessionNamesChange(next);
              }}
            >
              <XiaoIcon name="edit" size={10} />
            </button>
            {sessions.sessionIds.length > 1 ? (
              <button
                type="button"
                aria-label={`Close Terminal ${index + 1}`}
                onClick={() => {
                  void nativeBridge.stopTerminal(sessionId).catch(() => undefined);
                  updateSessions(removeTerminalSession(
                    sessions.sessionIds,
                    sessions.activeSessionId,
                    sessionId,
                  ));
                }}
              >
                <XiaoIcon name="close" size={10} />
              </button>
            ) : null}
          </span>
        ))}
        <button
          type="button"
          aria-label="New terminal session"
          title="New terminal session"
          onClick={() => updateSessions(addTerminalSession(sessions.sessionIds))}
        >
          <XiaoIcon name="add" size={12} />
        </button>
      </nav>
      {sessions.sessionIds.map((sessionId, index) => (
        <div key={sessionId} hidden={sessionId !== sessions.activeSessionId}>
          <TerminalSession
            sessionId={sessionId}
            active={active && sessionId === sessions.activeSessionId}
            workspace={workspace}
            taskId={taskId}
            system={system}
            transitioning={transitioning}
            sessionNumber={index + 1}
          />
        </div>
      ))}
    </div>
  );
}
