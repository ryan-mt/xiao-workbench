(() => {
  "use strict";

  const SESSION_KEY = "xiao.companion.browser.session.v1";
  const DEVICE_KEY = "xiao.companion.browser.device.v1";
  const DEFAULT_GRANTS = [
    "read_projects",
    "read_tasks",
    "read_runs",
    "read_attention",
    "read_safe_timeline",
    "read_conversation",
    "read_verification",
    "read_observatory",
    "resolve_pending_input",
    "stop_run",
    "retry_run",
    "send_follow_up",
    "create_task",
    "acknowledge_attention",
    "accept_outcome",
  ];
  const KIND_KEYS = {
    project: "projects",
    task: "tasks",
    task_stage: "tasks",
    run: "runs",
    pending_input: "pendingInputs",
    attention: "attention",
    safe_timeline: "timeline",
    verification: "verification",
    observatory: "observatory",
  };

  const elements = {
    connection: document.querySelector("#connection"),
    pairing: document.querySelector("#pairing"),
    pairForm: document.querySelector("#pair-form"),
    pairCopy: document.querySelector("#pair-copy"),
    pairButton: document.querySelector("#pair-button"),
    pairError: document.querySelector("#pair-error"),
    deviceName: document.querySelector("#device-name"),
    companion: document.querySelector("#companion"),
    hostLabel: document.querySelector("#host-label"),
    notice: document.querySelector("#notice"),
    refresh: document.querySelector("#refresh"),
    forget: document.querySelector("#forget"),
    newTask: document.querySelector("#new-task"),
    newTaskDialog: document.querySelector("#new-task-dialog"),
    newTaskForm: document.querySelector("#new-task-form"),
    projectSelect: document.querySelector("#project-select"),
    taskPrompt: document.querySelector("#task-prompt"),
    newTaskError: document.querySelector("#new-task-error"),
    cancelNewTask: document.querySelector("#cancel-new-task"),
    createTask: document.querySelector("#create-task"),
    conversationTitle: document.querySelector("#conversation-title"),
    conversationMeta: document.querySelector("#conversation-meta"),
    conversation: document.querySelector("#conversation-list"),
    runSelect: document.querySelector("#run-select"),
    chatForm: document.querySelector("#chat-form"),
    chatInput: document.querySelector("#chat-input"),
    chatCount: document.querySelector("#chat-count"),
    chatSend: document.querySelector("#chat-send"),
    workspaceDetails: document.querySelector("#workspace-details"),
    projects: document.querySelector("#projects-list"),
    runs: document.querySelector("#runs-list"),
    pending: document.querySelector("#pending-list"),
    attention: document.querySelector("#attention-list"),
    verification: document.querySelector("#verification-list"),
    observatory: document.querySelector("#observatory-list"),
  };

  let bundle = null;
  let stored = loadSession();
  let cursor = null;
  let polling = false;
  let timer = null;
  let live = false;
  let selectedRunId = null;
  let preferredTaskId = null;
  let chatSending = false;
  let taskCreating = false;
  const sentMessages = [];
  const conversationEvents = new Map();
  const conversationCursors = new Map();
  const projection = {
    projects: new Map(),
    tasks: new Map(),
    runs: new Map(),
    pendingInputs: new Map(),
    attention: new Map(),
    timeline: new Map(),
    verification: new Map(),
    observatory: new Map(),
  };

  function loadSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (
        !value
        || value.endpoint !== location.origin
        || !value.credential?.secret
        || !value.session?.sessionId
      ) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  function decodePairingFragment() {
    const encoded = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (!encoded) return null;
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    try {
      const padded = encoded.replace(/-/g, "+").replace(/_/g, "/")
        .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (
        value.endpoint !== location.origin
        || typeof value.ownerCredential !== "string"
        || typeof value.expiresAt !== "number"
      ) {
        throw new Error("This link belongs to a different Xiao host.");
      }
      if (value.expiresAt <= Date.now()) {
        throw new Error("This pairing link has expired. Create a fresh link on the primary host.");
      }
      return value;
    } catch (error) {
      showPairError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  function deviceId() {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  }

  async function api(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(value?.message || `The primary host refused the request (${response.status}).`);
    }
    return value;
  }

  function showPairError(message) {
    elements.pairError.textContent = message;
    elements.pairError.hidden = false;
  }

  function setConnection(state, text) {
    elements.connection.className = `status is-${state}`;
    elements.connection.textContent = text;
  }

  function setNotice(message) {
    elements.notice.textContent = message;
  }

  function emptyProjection() {
    for (const values of Object.values(projection)) values.clear();
  }

  function applyPage(page) {
    for (const update of page.updates || []) {
      const key = KIND_KEYS[update.kind];
      if (!key || update.generation !== page.generation) continue;
      const values = projection[key];
      if (update.payload?.deleted === true) values.delete(update.entityId);
      else values.set(update.entityId, update.payload);
    }
    cursor = {
      generation: page.generation,
      sequence: page.cursor,
      snapshot: page.nextSnapshot || null,
    };
  }

  async function reconcile(reset = false) {
    if (!stored || polling) return;
    polling = true;
    if (reset) {
      cursor = null;
      emptyProjection();
    }
    setConnection("stale", "Syncing");
    try {
      let hasMore = true;
      while (hasMore) {
        const page = await api("/v1/sync", {
          credential: stored.credential,
          sync: { cursor, limit: 500 },
        });
        applyPage(page);
        hasMore = Boolean(page.hasMore);
      }
      if (!cursor || cursor.snapshot) throw new Error("The host did not provide a live cursor.");
      const confirmed = await api("/v1/reconcile", {
        credential: stored.credential,
        cursor,
      });
      cursor = {
        generation: confirmed.generation,
        sequence: confirmed.cursor,
        snapshot: null,
      };
      live = true;
      setConnection("live", "Live");
      setNotice("Connected to the primary host.");
      render();
      await loadConversation(selectedRunId, reset);
    } catch (error) {
      live = false;
      setConnection("stale", "Disconnected");
      setNotice(error instanceof Error ? error.message : String(error));
      render();
    } finally {
      polling = false;
    }
  }

  async function poll() {
    if (!stored || polling || !cursor) return;
    polling = true;
    let requiresReconcile = false;
    try {
      const page = await api("/v1/sync", {
        credential: stored.credential,
        sync: { cursor, limit: 500 },
      });
      applyPage(page);
      live = page.phase === "live";
      requiresReconcile = !live || page.hasMore || Boolean(cursor?.snapshot);
      setConnection(live ? "live" : "stale", live ? "Live" : "Syncing");
      render();
      await loadConversation(selectedRunId);
    } catch (error) {
      live = false;
      setConnection("stale", "Disconnected");
      setNotice(error instanceof Error ? error.message : String(error));
      render();
    } finally {
      polling = false;
    }
    if (requiresReconcile) await reconcile();
  }

  async function execute(capability, target, expectedVersion, payload = {}) {
    if (!stored || !live) return false;
    const commandId = crypto.randomUUID();
    const envelope = {
      sessionId: stored.credential.sessionId,
      sessionGeneration: stored.credential.generation,
      deviceId: stored.credential.deviceId,
      commandId,
      idempotencyKey: `${stored.credential.deviceId}:${commandId}`,
      expectedVersion,
      target,
      auditTimestamp: Date.now(),
      capability,
      payload,
    };
    live = false;
    setConnection("stale", "Waiting");
    setNotice("Waiting for primary-host acknowledgement.");
    render();
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await api("/v1/commands", {
          credential: stored.credential,
          envelope,
        });
        if (result.state === "succeeded") {
          setNotice("The primary host acknowledged the action.");
          await reconcile();
          return true;
        }
        if (result.state === "refused") {
          throw new Error(result.message || result.refusalCode || "The primary host refused the action.");
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("The primary host did not acknowledge the action in time.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      await reconcile();
      return false;
    }
  }

  function node(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }

  function action(label, handler) {
    const button = node("button", "bounded-action", label);
    button.type = "button";
    button.disabled = !live;
    button.addEventListener("click", handler);
    return button;
  }

  function empty(container, message) {
    container.replaceChildren(node("p", "empty", message));
  }

  function renderProjects() {
    const projects = [...projection.projects.values()];
    const tasks = [...projection.tasks.values()];
    if (!projects.length && !tasks.length) {
      empty(elements.projects, "No authorized Projects or Tasks.");
      return;
    }
    const cards = projects.map((project) => {
      const card = node("article", "item");
      const heading = node("div", "item-row");
      heading.append(
        node("strong", "", project.name || project.id),
        node("span", "meta", `${project.taskCount ?? 0} tasks`),
      );
      card.append(heading);
      for (const task of tasks.filter((item) => item.projectId === project.id)) {
        const row = node("div", "item");
        const title = node("div", "item-row");
        title.append(
          node("strong", "", task.title || task.id),
          node("span", "meta", String(task.stage || "unknown").replaceAll("_", " ")),
        );
        row.append(title);
        if (task.outcomeAcceptancePermitted) {
          const actions = node("div", "actions");
          actions.append(action("Accept outcome", () => execute(
            "accept_outcome",
            { kind: "task", id: task.id, projectId: task.projectId },
            task.version,
          )));
          row.append(actions);
        }
        card.append(row);
      }
      return card;
    });
    elements.projects.replaceChildren(...cards);
  }

  function projectIdForRun(run) {
    if (run.projectId) return run.projectId;
    return taskForRun(run)?.projectId;
  }

  function taskForRun(run) {
    return [...projection.tasks.values()].find((task) =>
      task.id === run.taskId
      && (!run.projectId || task.projectId === run.projectId));
  }

  function renderRuns() {
    const runs = [...projection.runs.values()];
    if (!runs.length) {
      empty(elements.runs, "No authorized Runs.");
      return;
    }
    elements.runs.replaceChildren(...runs.map((run) => {
      const card = node("article", "item");
      const heading = node("div", "item-row");
      heading.append(
        node("strong", "", run.safeSummary || run.id),
        node("span", "meta", String(run.status || "unknown").replaceAll("_", " ")),
      );
      card.append(heading);
      const actions = node("div", "actions");
      const projectId = projectIdForRun(run);
      const target = { kind: "run", id: run.id, projectId };
      if (run.canStop) {
        actions.append(action("Stop", () => execute("stop_run", target, run.version)));
      }
      if (run.canRetry) {
        actions.append(action("Retry", () => execute("retry_run", target, run.version)));
      }
      if (actions.childElementCount) card.append(actions);
      return card;
    }));
  }

  function timestamp(value) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function readableKind(kind) {
    if (kind.startsWith("agent.")) return "Xiao";
    return kind.replaceAll(".", " ").replaceAll("_", " ");
  }

  function conversationRuns() {
    return [...projection.runs.values()].sort((left, right) => {
      if (left.taskId === preferredTaskId && right.taskId !== preferredTaskId) return -1;
      if (right.taskId === preferredTaskId && left.taskId !== preferredTaskId) return 1;
      if (left.canFollowUp !== right.canFollowUp) return left.canFollowUp ? -1 : 1;
      return String(left.id).localeCompare(String(right.id));
    });
  }

  function payloadText(value) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    for (const key of ["text", "message", "summary", "title", "content", "outputText"]) {
      const text = payloadText(value[key]);
      if (text) return text;
    }
    for (const key of ["params", "item", "result"]) {
      const text = payloadText(value[key]);
      if (text) return text;
    }
    return "";
  }

  async function loadConversation(runId, reset = false) {
    if (!stored || !runId) return;
    if (reset) {
      conversationEvents.delete(runId);
      conversationCursors.delete(runId);
    }
    const events = conversationEvents.get(runId) || new Map();
    let afterSequence = conversationCursors.get(runId) ?? null;
    try {
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page = await api("/v1/conversation", {
          credential: stored.credential,
          runId,
          afterSequence,
          limit: 200,
        });
        for (const event of page.events || []) events.set(event.sequence, event);
        if (!page.events?.length || page.events.length < 200) {
          afterSequence = page.nextSequence ?? afterSequence;
          break;
        }
        afterSequence = page.nextSequence;
      }
      conversationEvents.set(runId, events);
      conversationCursors.set(runId, afterSequence);
      if (runId === selectedRunId) renderConversation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function renderConversation() {
    const runs = conversationRuns();
    if (!runs.some((run) => run.id === selectedRunId)) {
      selectedRunId = runs[0]?.id || null;
    }
    elements.runSelect.replaceChildren(...runs.map((run) => {
      const option = node("option", "", run.safeSummary || run.id);
      option.value = run.id;
      option.selected = run.id === selectedRunId;
      return option;
    }));
    elements.runSelect.hidden = runs.length < 2;

    const run = projection.runs.get(selectedRunId);
    const task = run ? taskForRun(run) : null;
    elements.conversationTitle.textContent = task?.title || "Conversation";
    elements.conversationMeta.textContent = run
      ? `${String(run.status || "unknown").replaceAll("_", " ")} · ${run.safeSummary || run.id}`
      : "No run is available yet.";

    const fullTimeline = [...(conversationEvents.get(selectedRunId)?.values() || [])]
      .map((entry) => ({
        id: `${entry.runId}:${entry.sequence}`,
        runId: entry.runId,
        occurredAt: entry.timestamp,
        kind: entry.eventType,
        safeSummary: payloadText(entry.safePayload) || readableKind(entry.eventType),
        local: false,
      }));
    const timeline = fullTimeline.length
      ? fullTimeline
      : [...projection.timeline.values()]
        .filter((entry) => entry.runId === selectedRunId)
        .map((entry) => ({ ...entry, local: false }));
    const local = sentMessages
      .filter((entry) => entry.runId === selectedRunId)
      .map((entry) => ({ ...entry, local: true }));
    const messages = [...timeline, ...local]
      .sort((left, right) => left.occurredAt - right.occurredAt);

    if (!messages.length) {
      empty(
        elements.conversation,
        run?.canFollowUp
          ? "No shared activity yet. Send a follow-up to the active run."
          : "No shared activity for this run.",
      );
    } else {
      elements.conversation.replaceChildren(...messages.map((message) => {
        const item = node("article", `message${message.local ? " is-user" : ""}`);
        const heading = node("div", "message-heading");
        heading.append(
          node("strong", "", message.local ? "You" : readableKind(message.kind)),
          node("time", "", timestamp(message.occurredAt)),
        );
        item.append(heading, node("p", "", message.local ? message.text : message.safeSummary));
        return item;
      }));
    }

    const writable = Boolean(run?.canFollowUp && live && !chatSending);
    elements.chatInput.disabled = !writable;
    elements.chatSend.disabled = !writable || !elements.chatInput.value.trim();
    elements.chatInput.placeholder = run?.canFollowUp
      ? live ? "Message Xiao" : "Waiting for the host"
      : "This run is not accepting follow-ups";
    elements.workspaceDetails.open = projection.pendingInputs.size > 0
      || projection.attention.size > 0;
  }

  function renderPending() {
    const values = [...projection.pendingInputs.values()];
    if (!values.length) {
      empty(elements.pending, "Nothing is waiting for input.");
      return;
    }
    elements.pending.replaceChildren(...values.map((pending) => {
      const card = node("article", "item");
      card.append(node("strong", "", pending.safePrompt || pending.id));
      const run = projection.runs.get(pending.runId);
      const capability = pending.kind === "approval"
        ? "resolve_approval"
        : pending.kind === "question"
          ? "resolve_question"
          : "resolve_mcp_elicitation";
      const actions = node("div", "actions");
      for (const option of pending.options || []) {
        actions.append(action(option.label || option.id, () => execute(
          capability,
          { kind: "pending_input", id: pending.id, projectId: projectIdForRun(run || {}) },
          pending.version,
          { optionId: option.id },
        )));
      }
      card.append(actions);
      return card;
    }));
  }

  function renderAttention() {
    const values = [...projection.attention.values()];
    if (!values.length) {
      empty(elements.attention, "No Attention items.");
      return;
    }
    elements.attention.replaceChildren(...values.map((item) => {
      const card = node("article", "item");
      card.append(
        node("strong", "", item.title || item.id),
        node("p", "", item.safeSummary || ""),
      );
      if (!item.acknowledged) {
        const actions = node("div", "actions");
        actions.append(action("Acknowledge", () => execute(
          "acknowledge_attention",
          { kind: "attention", id: item.id, projectId: item.projectId },
          item.version,
        )));
        card.append(actions);
      }
      return card;
    }));
  }

  function renderVerification() {
    const values = [...projection.verification.values()];
    if (!values.length) {
      empty(elements.verification, "No verification result yet.");
      return;
    }
    elements.verification.replaceChildren(...values.map((item) => {
      const card = node("article", "item");
      const row = node("div", "item-row");
      row.append(
        node("strong", "", projection.runs.get(item.runId)?.safeSummary || item.runId),
        node("span", "meta", String(item.status || "unknown").replaceAll("_", " ")),
      );
      card.append(row, node("p", "", item.safeSummary || ""));
      return card;
    }));
  }

  function renderObservatory() {
    const values = [...projection.observatory.values()];
    if (!values.length) {
      empty(elements.observatory, "No active agent activity.");
      return;
    }
    elements.observatory.replaceChildren(...values.map((item) => {
      const card = node("article", "item");
      const row = node("div", "item-row");
      const active = Number(item.activeAgents || 0);
      const waiting = Number(item.waitingAgents || 0);
      row.append(
        node("strong", "", projection.runs.get(item.runId)?.safeSummary || item.runId),
        node("span", "meta", active ? `${active} active` : waiting ? `${waiting} waiting` : "idle"),
      );
      card.append(row);
      if (item.safeLatestActivity) {
        card.append(node("p", "", readableKind(item.safeLatestActivity)));
      }
      return card;
    }));
  }

  function render() {
    renderConversation();
    renderProjects();
    renderRuns();
    renderPending();
    renderAttention();
    renderVerification();
    renderObservatory();
    elements.newTask.disabled = !live || projection.projects.size === 0 || taskCreating;
  }

  async function sendChat(event) {
    event.preventDefault();
    const run = projection.runs.get(selectedRunId);
    const message = elements.chatInput.value.trim();
    if (!run?.canFollowUp || !message || chatSending) return;
    chatSending = true;
    renderConversation();
    const accepted = await execute(
      "send_follow_up",
      { kind: "run", id: run.id, projectId: projectIdForRun(run) },
      run.version,
      { message },
    );
    if (accepted) {
      sentMessages.push({
        runId: run.id,
        text: message,
        occurredAt: Date.now(),
      });
      elements.chatInput.value = "";
      elements.chatCount.textContent = "0 / 500";
    }
    chatSending = false;
    renderConversation();
  }

  function renderProjectOptions() {
    const projects = [...projection.projects.values()];
    elements.projectSelect.replaceChildren(...projects.map((project) => {
      const option = node("option", "", project.name || project.id);
      option.value = project.id;
      return option;
    }));
  }

  function openNewTask() {
    renderProjectOptions();
    elements.newTaskError.hidden = true;
    elements.taskPrompt.value = "";
    elements.newTaskDialog.showModal();
    elements.taskPrompt.focus();
  }

  async function createTask(event) {
    event.preventDefault();
    const project = projection.projects.get(elements.projectSelect.value);
    const prompt = elements.taskPrompt.value.trim();
    if (!project || !prompt || taskCreating) return;
    taskCreating = true;
    elements.newTaskError.hidden = true;
    elements.createTask.disabled = true;
    elements.createTask.textContent = "Starting...";
    const taskId = crypto.randomUUID();
    preferredTaskId = taskId;
    const accepted = await execute(
      "create_task",
      { kind: "project", id: project.id },
      project.version,
      { taskId, prompt },
    );
    taskCreating = false;
    elements.createTask.disabled = false;
    elements.createTask.textContent = "Start task";
    if (accepted) {
      elements.newTaskDialog.close();
      selectedRunId = null;
      await reconcile(true);
      return;
    }
    preferredTaskId = null;
    elements.newTaskError.textContent = "The primary host could not start this task.";
    elements.newTaskError.hidden = false;
  }

  async function pair(event) {
    event.preventDefault();
    elements.pairError.hidden = true;
    if (!bundle) return;
    if (bundle.expiresAt <= Date.now()) {
      showPairError("This pairing link has expired. Create a fresh link on the primary host.");
      return;
    }
    const deviceName = elements.deviceName.value.trim();
    if (!deviceName) return;
    elements.pairButton.disabled = true;
    elements.pairButton.textContent = "Pairing…";
    try {
      const exchanged = await api("/v1/pair", {
        ownerCredential: bundle.ownerCredential,
        deviceId: deviceId(),
        deviceName,
        grants: DEFAULT_GRANTS,
        now: Math.floor(Date.now() / 1000),
      });
      stored = {
        endpoint: location.origin,
        credential: exchanged.credential,
        session: exchanged.session,
        certificateFingerprint: bundle.certificateFingerprint,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
      bundle = null;
      showCompanion();
      await reconcile(true);
      clearInterval(timer);
      timer = setInterval(() => void poll(), 2_000);
    } catch (error) {
      showPairError(error instanceof Error ? error.message : String(error));
      elements.pairButton.disabled = false;
      elements.pairButton.textContent = "Pair device";
    }
  }

  function showCompanion() {
    elements.pairing.hidden = true;
    elements.companion.hidden = false;
    elements.hostLabel.textContent = `Paired with ${location.host}`;
    setConnection("stale", "Syncing");
  }

  function forget() {
    localStorage.removeItem(SESSION_KEY);
    stored = null;
    cursor = null;
    live = false;
    emptyProjection();
    clearInterval(timer);
    location.reload();
  }

  elements.pairForm.addEventListener("submit", pair);
  elements.refresh.addEventListener("click", () => void reconcile(true));
  elements.forget.addEventListener("click", forget);
  elements.newTask.addEventListener("click", openNewTask);
  elements.cancelNewTask.addEventListener("click", () => elements.newTaskDialog.close());
  elements.newTaskForm.addEventListener("submit", (event) => void createTask(event));
  elements.runSelect.addEventListener("change", () => {
    selectedRunId = elements.runSelect.value;
    renderConversation();
    void loadConversation(selectedRunId);
  });
  elements.chatInput.addEventListener("input", () => {
    elements.chatCount.textContent = `${elements.chatInput.value.length} / 500`;
    renderConversation();
  });
  elements.chatForm.addEventListener("submit", (event) => void sendChat(event));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void poll();
  });

  bundle = decodePairingFragment();
  if (stored) {
    showCompanion();
    void reconcile(true);
    timer = setInterval(() => void poll(), 2_000);
  } else {
    setConnection("idle", "Not paired");
    if (bundle) {
      elements.pairCopy.textContent = "Pairing link ready. Name this device to continue.";
      elements.pairButton.disabled = false;
      elements.deviceName.focus();
    }
  }
})();
