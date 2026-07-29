import { Reveal } from "@/components/Reveal";

const principles = [
  {
    title: "Codex-native",
    body: "A control plane for Codex Operators, not an agent-agnostic orchestration platform.",
  },
  {
    title: "Local-first",
    body: "Git, filesystem, native terminal, and host authority stay on your machine.",
  },
  {
    title: "Task-shaped",
    body: "Durable Tasks hold intent across Runs so stop is never confused with done.",
  },
] as const;

export function Story() {
  return (
    <section id="story" className="band band-shift" aria-labelledby="story-heading">
      <div className="frame">
        <Reveal>
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14">
            <h2
              id="story-heading"
              className="h-section max-w-[12ch] text-[2.35rem] sm:text-5xl md:text-[3.4rem]"
            >
              Agent streams are loud. The desk should not be.
            </h2>
            <div className="space-y-5 lg:pt-3">
              <p className="prose">
                Coding agents stream plans, tool calls, diffs, approvals, and
                follow-ups. Xiao keeps that stream readable in one Task
                Workbench: conversation central, supporting tools at the edge.
              </p>
              <p className="prose">
                It talks to the Codex app server already on your machine. No
                remote agent runtime hidden behind a web app. No analytics layer
                added by Xiao.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal className="mt-12 md:mt-16" delayMs={50}>
          <p className="mono mb-3">Principles</p>
          <div className="ledger">
            {principles.map((item) => (
              <article key={item.title} className="ledger-row">
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
