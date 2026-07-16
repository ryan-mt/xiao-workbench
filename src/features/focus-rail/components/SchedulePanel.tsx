import { useState } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";

export type ScheduledTask = {
  id: string;
  prompt: string;
  runAt: number;
  status: "pending" | "running" | "completed" | "failed";
};

type SchedulePanelProps = {
  tasks: ScheduledTask[];
  onAdd: (prompt: string, runAt: number) => void;
  onRemove: (id: string) => void;
};

export function SchedulePanel({ tasks, onAdd, onRemove }: SchedulePanelProps) {
  const [prompt, setPrompt] = useState("");
  const [runAt, setRunAt] = useState("");
  return (
    <section className="rail-section schedule-panel">
      <header className="rail-section__header">
        <div><span>Background queue</span><h2>Scheduled tasks</h2></div>
        <XiaoIcon name="routine" size={20} />
      </header>
      <p className="rail-section__summary">Runs while Xiao is open. Completed tasks notify you when desktop notifications are enabled.</p>
      <div className="schedule-form">
        <textarea rows={3} value={prompt} placeholder="What should Xiao do?" onChange={(event) => setPrompt(event.target.value)} />
        <input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />
        <button className="button button--primary" disabled={!prompt.trim() || !runAt || Number.isNaN(new Date(runAt).getTime())}
          onClick={() => { onAdd(prompt.trim(), new Date(runAt).getTime()); setPrompt(""); setRunAt(""); }}>
          Schedule
        </button>
      </div>
      <div className="schedule-list">
        {tasks.map((task) => (
          <article key={task.id}>
            <span className={`schedule-status schedule-status--${task.status}`} />
            <div><strong>{task.prompt}</strong><small>{new Date(task.runAt).toLocaleString()} · {task.status}</small></div>
            <button className="icon-button" aria-label="Remove scheduled task" onClick={() => onRemove(task.id)}><XiaoIcon name="close" size={13} /></button>
          </article>
        ))}
        {tasks.length === 0 && <div className="rail-empty"><XiaoIcon name="routine" size={24} /><strong>No scheduled tasks</strong><p>Queue a prompt to run later.</p></div>}
      </div>
    </section>
  );
}
