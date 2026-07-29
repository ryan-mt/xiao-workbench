import Image from "next/image";

import { Reveal } from "@/components/Reveal";

const stages = [
  {
    title: "Open a Project",
    body: "Add a codebase as the durable home for related Tasks. Project Groups only organize the sidebar.",
  },
  {
    title: "Describe a Task",
    body: "Capture operator intent once. Many Runs can follow while stage, plan, and timeline stay on the Task.",
  },
  {
    title: "Supervise the Run",
    body: "Approvals, diffs, terminal, browser preview, and Observatory stay on the same workbench surface.",
  },
  {
    title: "Review, publish, complete",
    body: "Ready for review is not published, and neither is completed. Stage moves when the outcome earns it.",
  },
] as const;

export function Flow() {
  return (
    <section id="flow" className="band band-shift" aria-labelledby="flow-heading">
      <div className="frame">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:items-start lg:gap-16">
          <Reveal>
            <p className="mono">Procedure</p>
            <h2
              id="flow-heading"
              className="h-section mt-3 max-w-[10ch] text-[2.2rem] sm:text-5xl md:text-[3.2rem]"
            >
              From intent to outcome
            </h2>
            <p className="prose mt-4">
              Tasks and Runs are modeled separately so retries, routines, and
              verification do not mark work done just because Codex stopped.
            </p>

            <ol className="spine mt-10">
              {stages.map((stage, index) => (
                <li key={stage.title}>
                  <span className="n">
                    Step {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{stage.title}</h3>
                  <p>{stage.body}</p>
                </li>
              ))}
            </ol>
          </Reveal>

          <Reveal delayMs={70} className="lg:sticky lg:top-24">
            <div className="specimen">
              <Image
                src="/screenshots/new-task.png"
                alt="New task composer asking what should we work on"
                width={1600}
                height={1000}
                sizes="(max-width: 1024px) 100vw, 48vw"
              />
              <div className="specimen-meta">
                <span>Fig. new task</span>
                <span>Describe outcome first</span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
