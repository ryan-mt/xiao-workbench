import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import { nativeBridge } from "../../../core/bridges/tauri";
import type { AgentRuntimeState } from "../../../core/models/agent";
import type { WorkspaceSnapshot } from "../../../core/models/workspace";
import { workspacePathComparisonKey } from "../../../core/workspacePath";

type Skill = { name: string; description: string; path: string; enabled: boolean };
type Plugin = {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  availability?: "AVAILABLE" | "DISABLED_BY_ADMIN";
  installPolicy?: "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT";
  interface?: { displayName: string | null; shortDescription: string | null } | null;
  marketplaceName: string;
  marketplacePath: string | null;
};
type App = { id: string; name: string; description: string | null; isAccessible: boolean; isEnabled: boolean };
type McpServer = {
  name: string;
  displayName: string;
  toolCount: number;
  authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
};
type McpServerResponse = Omit<McpServer, "displayName" | "toolCount"> & {
  serverInfo: { title?: string | null } | null;
  tools: Record<string, unknown>;
};
type CapabilitySource = "apps" | "mcp" | "plugins" | "skills";
type CapabilityIssue = { message: string; tone: "error" | "notice" };
type CapabilityIdentity = {
  generation: number;
  key: string;
  projectPath: string;
  taskId: string;
};
type ScopedBusy = { generation: number; key: string };
type ScopedError = { generation: number; message: string };

type ExtensionsPanelProps = {
  workspace: WorkspaceSnapshot;
  taskId: string | null;
  runtime: AgentRuntimeState;
};

const conciseError = (reason: unknown) => {
  const value = reason instanceof Error ? reason.message : String(reason);
  const withoutHtml = value.replace(/<!doctype html[\s\S]*/i, "").replace(/<html[\s\S]*/i, "").trim();
  return (withoutHtml || "Capability source is temporarily unavailable.").replace(/\s+/g, " ").slice(0, 180);
};

const sourceIssue = (source: CapabilitySource, reason: unknown): CapabilityIssue => {
  if (source === "apps") {
    return {
      message: "Apps are temporarily unavailable from ChatGPT. Skills, plugins, and MCP servers still work.",
      tone: "notice",
    };
  }
  const label = source === "mcp" ? "MCP servers" : `${source[0].toUpperCase()}${source.slice(1)}`;
  return { message: `${label} could not be loaded. ${conciseError(reason)}`, tone: "error" };
};

const isAccessDenied = (reason: unknown) => /\b(?:401|403)\b|forbidden|unauthorized/i.test(conciseError(reason));

const mcpDescription = (server: McpServer) => {
  const tools = `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`;
  if (server.authStatus === "notLoggedIn") return `${tools} · Sign-in required`;
  if (server.authStatus === "oAuth") return `${tools} · OAuth connected`;
  if (server.authStatus === "bearerToken") return `${tools} · Token connected`;
  return tools;
};

const pluginAction = (plugin: Plugin) => {
  if (plugin.installed) return "Uninstall";
  if (plugin.availability === "DISABLED_BY_ADMIN" || plugin.installPolicy === "NOT_AVAILABLE") return undefined;
  return "Install";
};


export function ExtensionsPanel({ workspace, taskId, runtime }: ExtensionsPanelProps) {
  const runtimeAvailable = runtime.phase === "ready" || runtime.phase === "working";
  const [skills, setSkills] = useState<Skill[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [query, setQuery] = useState("");
  const [dataGeneration, setDataGeneration] = useState<number | null>(null);
  const [loadingGeneration, setLoadingGeneration] = useState<number | null>(null);
  const [busy, setBusy] = useState<ScopedBusy | null>(null);
  const [error, setError] = useState<ScopedError | null>(null);
  const [issues, setIssues] = useState<Partial<Record<CapabilitySource, CapabilityIssue>>>({});
  const refreshEpoch = useRef(0);
  const appAccessBlocked = useRef(false);
  const identityState = useRef<{
    key: string | null;
    generation: number;
    current: CapabilityIdentity | null;
  }>({ key: null, generation: 0, current: null });

  const nextIdentityKey = runtimeAvailable && taskId
    ? `${workspacePathComparisonKey(workspace.path)}\u0000${taskId}`
    : null;
  if (identityState.current.key !== nextIdentityKey) {
    const generation = identityState.current.generation + 1;
    identityState.current = {
      key: nextIdentityKey,
      generation,
      current: nextIdentityKey && taskId
        ? { generation, key: nextIdentityKey, projectPath: workspace.path, taskId }
        : null,
    };
    appAccessBlocked.current = false;
  }
  const identity = identityState.current.current;
  const isCurrentIdentity = (candidate: CapabilityIdentity) =>
    identityState.current.current?.generation === candidate.generation &&
    identityState.current.current.key === candidate.key;

  const refresh = useCallback(async (origin: CapabilityIdentity, force = false) => {
    if (!isCurrentIdentity(origin)) return;
    const requestId = ++refreshEpoch.current;
    setLoadingGeneration(origin.generation);
    setError(null);
    setDataGeneration(null);
    setSkills([]);
    setPlugins([]);
    setApps([]);
    setMcpServers([]);
    setIssues({});
    try {
      const appRequest = appAccessBlocked.current && !force
        ? Promise.resolve(null)
        : nativeBridge.agentRequest<{ data: App[] }>(
            "app/list",
            { forceRefetch: force, limit: 100 },
            { projectPath: origin.projectPath, taskId: origin.taskId },
          );
      const [skillResult, pluginResult, mcpResult, appResult] = await Promise.allSettled([
        nativeBridge.agentRequest<{ data: Array<{ skills: Skill[] }> }>(
          "skills/list",
          { cwds: [origin.projectPath], forceReload: force },
          { projectPath: origin.projectPath, taskId: origin.taskId },
        ),
        nativeBridge.agentRequest<{
          marketplaces: Array<{ name: string; path: string | null; plugins: Omit<Plugin, "marketplaceName" | "marketplacePath">[] }>;
          marketplaceLoadErrors?: Array<{ message: string }>;
        }>(
          "plugin/list",
          { cwds: [origin.projectPath] },
          { projectPath: origin.projectPath, taskId: origin.taskId },
        ),
        nativeBridge.agentRequest<{ data: McpServerResponse[] }>(
          "mcpServerStatus/list",
          { detail: "toolsAndAuthOnly", limit: 100 },
          { projectPath: origin.projectPath, taskId: origin.taskId },
        ),
        appRequest,
      ]);
      if (!isCurrentIdentity(origin) || requestId !== refreshEpoch.current) return;

      const nextIssues: Partial<Record<CapabilitySource, CapabilityIssue>> = {};
      if (skillResult.status === "fulfilled") {
        setSkills(skillResult.value.data.flatMap((entry) => entry.skills));
      } else {
        setSkills([]);
        nextIssues.skills = sourceIssue("skills", skillResult.reason);
      }
      if (pluginResult.status === "fulfilled") {
        setPlugins(
          pluginResult.value.marketplaces.flatMap((marketplace) =>
            marketplace.plugins.map((plugin) => ({
              ...plugin,
              marketplaceName: marketplace.name,
              marketplacePath: marketplace.path,
            })),
          ),
        );
        if (pluginResult.value.marketplaceLoadErrors?.length) {
          nextIssues.plugins = {
            message: `${pluginResult.value.marketplaceLoadErrors.length} plugin marketplace ${pluginResult.value.marketplaceLoadErrors.length === 1 ? "error was" : "errors were"} skipped.`,
            tone: "notice",
          };
        }
      } else {
        setPlugins([]);
        nextIssues.plugins = sourceIssue("plugins", pluginResult.reason);
      }
      if (mcpResult.status === "fulfilled") {
        setMcpServers(mcpResult.value.data.map((server) => ({
          name: server.name,
          displayName: server.serverInfo?.title || server.name,
          toolCount: Object.keys(server.tools ?? {}).length,
          authStatus: server.authStatus,
        })));
      } else {
        setMcpServers([]);
        nextIssues.mcp = sourceIssue("mcp", mcpResult.reason);
      }
      if (appResult.status === "fulfilled" && appResult.value) {
        appAccessBlocked.current = false;
        setApps(appResult.value.data);
      } else if (appResult.status === "rejected") {
        appAccessBlocked.current = isAccessDenied(appResult.reason);
        setApps([]);
        nextIssues.apps = sourceIssue("apps", appResult.reason);
      } else {
        nextIssues.apps = sourceIssue("apps", null);
      }
      setIssues(nextIssues);
      setDataGeneration(origin.generation);
    } catch (reason) {
      if (isCurrentIdentity(origin) && requestId === refreshEpoch.current) {
        setError({ generation: origin.generation, message: conciseError(reason) });
      }
    } finally {
      if (isCurrentIdentity(origin) && requestId === refreshEpoch.current) {
        setLoadingGeneration(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!identity) {
      refreshEpoch.current += 1;
      appAccessBlocked.current = false;
      setSkills([]);
      setPlugins([]);
      setApps([]);
      setMcpServers([]);
      setDataGeneration(null);
      setLoadingGeneration(null);
      setBusy(null);
      setError(null);
      setIssues({});
      return;
    }
    void refresh(identity);
    return () => {
      if (isCurrentIdentity(identity)) refreshEpoch.current += 1;
    };
  }, [identity, refresh]);

  const updateSkill = async (origin: CapabilityIdentity, skill: Skill) => {
    if (!isCurrentIdentity(origin)) return;
    const busyKey = `skill:${skill.path}`;
    setBusy({ generation: origin.generation, key: busyKey });
    try {
      await nativeBridge.agentRequest(
        "skills/config/write",
        { path: skill.path, enabled: !skill.enabled },
        { projectPath: origin.projectPath, taskId: origin.taskId },
      );
      if (!isCurrentIdentity(origin)) return;
      await refresh(origin);
    } catch (reason) {
      if (isCurrentIdentity(origin)) {
        setError({ generation: origin.generation, message: conciseError(reason) });
      }
    } finally {
      if (isCurrentIdentity(origin)) {
        setBusy((current) =>
          current?.generation === origin.generation && current.key === busyKey ? null : current,
        );
      }
    }
  };

  const updatePlugin = async (origin: CapabilityIdentity, plugin: Plugin) => {
    if (!isCurrentIdentity(origin)) return;
    const busyKey = `plugin:${plugin.id}`;
    setBusy({ generation: origin.generation, key: busyKey });
    try {
      if (plugin.installed) {
        await nativeBridge.agentRequest(
          "plugin/uninstall",
          { pluginId: plugin.id },
          { projectPath: origin.projectPath, taskId: origin.taskId },
        );
      } else {
        await nativeBridge.agentRequest(
          "plugin/install",
          {
            pluginName: plugin.name,
            marketplacePath: plugin.marketplacePath,
            remoteMarketplaceName: plugin.marketplacePath ? null : plugin.marketplaceName,
          },
          { projectPath: origin.projectPath, taskId: origin.taskId },
        );
      }
      if (!isCurrentIdentity(origin)) return;
      await refresh(origin);
    } catch (reason) {
      if (isCurrentIdentity(origin)) {
        setError({ generation: origin.generation, message: conciseError(reason) });
      }
    } finally {
      if (isCurrentIdentity(origin)) {
        setBusy((current) =>
          current?.generation === origin.generation && current.key === busyKey ? null : current,
        );
      }
    }
  };

  const normalized = query.trim().toLowerCase();
  const hasCurrentData = Boolean(identity && dataGeneration === identity.generation);
  const scopedSkills = hasCurrentData ? skills : [];
  const scopedPlugins = hasCurrentData ? plugins : [];
  const scopedMcpServers = hasCurrentData ? mcpServers : [];
  const scopedApps = hasCurrentData ? apps : [];
  const filter = <T extends { name: string }>(items: T[]) =>
    normalized ? items.filter((item) => item.name.toLowerCase().includes(normalized)) : items;
  const visible = useMemo(
    () => ({
      skills: filter(scopedSkills),
      plugins: filter(scopedPlugins),
      mcp: filter(scopedMcpServers),
      apps: filter(scopedApps),
    }),
    [normalized, scopedApps, scopedMcpServers, scopedPlugins, scopedSkills],
  );
  const loading = Boolean(identity && loadingGeneration === identity.generation);
  const currentBusy = identity && busy?.generation === identity.generation ? busy.key : null;
  const currentError = identity && error?.generation === identity.generation ? error.message : null;
  const currentIssues = hasCurrentData ? issues : {};

  return (
    <section className="rail-section extensions-panel">
      <header className="rail-section__header">
        <div><span>Capabilities</span><h2>Skills, plugins, MCP, and apps</h2></div>
        <button className="icon-button" type="button" disabled={loading || !identity}
          onClick={() => { if (identity) void refresh(identity, true); }} aria-label="Refresh capabilities">
          <XiaoIcon className={loading ? "spin" : undefined} name="refresh" size={17} />
        </button>
      </header>
      <label className="rail-search">
        <XiaoIcon name="search" size={15} />
        <input type="search" value={query} aria-label="Filter capabilities" placeholder="Filter capabilities" onChange={(event) => setQuery(event.target.value)} />
      </label>
      {currentError && <p className="rail-error">{currentError}</p>}
      {loading ? <div className="file-skeleton"><span /><span /><span /></div> : (
        <>
          <CapabilityGroup title={`Skills (${visible.skills.length})`} empty="No skills found." issue={currentIssues.skills}>
            {visible.skills.map((skill) => (
              <CapabilityRow key={skill.path} name={skill.name} description={skill.description} active={skill.enabled}
                busy={currentBusy === `skill:${skill.path}`} action={identity ? (skill.enabled ? "Disable" : "Enable") : undefined}
                onAction={identity ? () => void updateSkill(identity, skill) : undefined} />
            ))}
          </CapabilityGroup>
          <CapabilityGroup title={`Plugins (${visible.plugins.length})`} empty="No plugins found." issue={currentIssues.plugins}>
            {visible.plugins.map((plugin) => (
              <CapabilityRow key={`${plugin.marketplaceName}:${plugin.id}`} name={plugin.interface?.displayName || plugin.name}
                description={plugin.availability === "DISABLED_BY_ADMIN" ? "Disabled by administrator" : plugin.interface?.shortDescription ?? plugin.marketplaceName}
                active={plugin.installed && plugin.enabled}
                busy={currentBusy === `plugin:${plugin.id}`} action={identity ? pluginAction(plugin) : undefined}
                onAction={identity ? () => void updatePlugin(identity, plugin) : undefined} />
            ))}
          </CapabilityGroup>
          <CapabilityGroup title={`MCP servers (${visible.mcp.length})`} empty="No MCP servers configured." issue={currentIssues.mcp}>
            {visible.mcp.map((server) => (
              <CapabilityRow key={server.name} name={server.displayName}
                description={mcpDescription(server)} active={server.authStatus !== "notLoggedIn"} />
            ))}
          </CapabilityGroup>
          <CapabilityGroup title={`Apps (${visible.apps.length})`} empty="No apps available." issue={currentIssues.apps}>
            {visible.apps.map((app) => (
              <CapabilityRow key={app.id} name={app.name} description={app.description ?? "Connected app"}
                active={app.isAccessible && app.isEnabled} />
            ))}
          </CapabilityGroup>
        </>
      )}
    </section>
  );
}

function CapabilityGroup({ title, children, empty, issue }: {
  title: string;
  children: ReactNode;
  empty: string;
  issue?: CapabilityIssue;
}) {
  const hasChildren = Boolean(Children.count(children));
  return (
    <div className="capability-group">
      <h3>{title}</h3>
      <div>
        {issue && hasChildren ? (
          <p className={`capability-state ${issue.tone === "error" ? "is-error" : ""}`} role={issue.tone === "error" ? "alert" : "status"}>
            {issue.message}
          </p>
        ) : null}
        {hasChildren ? children : (
          <p className={`capability-state ${issue?.tone === "error" ? "is-error" : ""}`} role={issue?.tone === "error" ? "alert" : "status"}>
            {issue?.message ?? empty}
          </p>
        )}
      </div>
    </div>
  );
}

function CapabilityRow({ name, description, active, busy, action, onAction }: {
  name: string; description: string; active: boolean; busy?: boolean; action?: string; onAction?: () => void;
}) {
  return (
    <article className="capability-row">
      <span className={active ? "is-active" : ""}><XiaoIcon name="capability" size={15} /></span>
      <div><strong>{name}</strong><small>{description}</small></div>
      {action && <button className="button button--quiet" type="button" disabled={busy} onClick={onAction}>{busy ? "…" : action}</button>}
    </article>
  );
}
