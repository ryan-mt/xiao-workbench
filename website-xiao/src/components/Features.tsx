import Image from "next/image";

import { Reveal } from "@/components/Reveal";

const folios = [
  {
    index: "Surface A",
    title: "Focus Rail beside the conversation",
    body: "Files, diffs, repository actions, runtime context, and a real native terminal stay one reach away. The middle of the screen stays the task.",
    image: "/screenshots/sidebar.png",
    alt: "Xiao sidebar and workbench",
    flip: false,
    fig: "Fig. rail",
  },
  {
    index: "Surface B",
    title: "Attention Center across projects",
    body: "Decisions, verification, failures, review, publication, and routine outcomes surface here instead of vanishing into scrollback.",
    image: "/screenshots/attention.png",
    alt: "Attention Center",
    flip: true,
    fig: "Fig. attention",
  },
  {
    index: "Surface C",
    title: "Command menu and local prefs",
    body: "Jump across projects and actions without leaving the desk. Themes stay light, dark, or system. Profile stays on the host.",
    image: "/screenshots/command-menu.png",
    alt: "Command menu",
    flip: false,
    fig: "Fig. command",
  },
] as const;

const also = [
  {
    title: "Streaming Codex tasks",
    body: "Tool activity, approvals, plans, and follow-ups stay on the Task timeline.",
  },
  {
    title: "Isolated Task workspaces",
    body: "Git projects default to a managed worktree so concurrent Runs do not share one checkout.",
  },
  {
    title: "Companion on your phone",
    body: "Pair on the same LAN to monitor, chat, assign a Task, and take bounded interventions. Host stays authoritative.",
  },
  {
    title: "Browser, terminal, Xiao Break",
    body: "Research browser, native PTY, and a muted break panel while a run is still working.",
  },
] as const;

export function Features() {
  return (
    <section id="features" className="band" aria-labelledby="features-heading">
      <div className="frame">
        <Reveal className="max-w-2xl">
          <p className="mono">Catalog</p>
          <h2
            id="features-heading"
            className="h-section mt-3 text-[2.2rem] sm:text-5xl md:text-[3.2rem]"
          >
            What ships in the beta
          </h2>
          <p className="prose mt-4">
            From the product source and README. Not a roadmap deck.
          </p>
        </Reveal>

        <div className="mt-10 md:mt-12">
          {folios.map((folio, index) => (
            <Reveal
              key={folio.title}
              delayMs={index * 40}
              className={`folio ${folio.flip ? "is-flip" : ""}`}
            >
              <div className="folio-text">
                <p className="folio-index">{folio.index}</p>
                <h3>{folio.title}</h3>
                <p>{folio.body}</p>
              </div>
              <figure className="folio-media">
                <div className="specimen">
                  <Image
                    src={folio.image}
                    alt={folio.alt}
                    width={1600}
                    height={1000}
                    sizes="(max-width: 920px) 100vw, 55vw"
                  />
                  <div className="specimen-meta">
                    <span>{folio.fig}</span>
                    <span>Beta capture</span>
                  </div>
                </div>
              </figure>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-6 md:mt-8" delayMs={60}>
          <p className="mono mb-3">Also included</p>
          <div className="ledger">
            {also.map((item) => (
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
