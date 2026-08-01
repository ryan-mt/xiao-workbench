import { Reveal } from "@/components/Reveal";

const points = [
  {
    title: "Host stays authoritative",
    body: "The local Xiao host owns the Codex runtime and canonical state.",
  },
  {
    title: "No product analytics",
    body: "Xiao does not add its own analytics. Sites in the research browser keep their policies; Codex follows your local install.",
  },
  {
    title: "Open source under MIT",
    body: "Active development lives on the dev branch. The Windows beta ships as a pre-release installer from GitHub Releases.",
  },
  {
    title: "Honest about beta",
    body: "Native WebViews, installer behavior, and long sessions still need more miles on more Windows machines.",
  },
] as const;

export function Difference() {
  return (
    <section
      id="difference"
      className="band band-shift"
      aria-labelledby="difference-heading"
    >
      <div className="frame">
        <Reveal className="max-w-2xl">
          <p className="mono">Colophon</p>
          <h2
            id="difference-heading"
            className="h-section mt-3 max-w-[12ch] text-[2.2rem] sm:text-5xl md:text-[3.2rem]"
          >
            Built to stay small and local
          </h2>
          <p className="prose mt-4">
            Decisions favor a calm operator surface over a platform that tries to
            host every agent and every cloud workflow.
          </p>
        </Reveal>

        <Reveal className="mt-10 md:mt-12" delayMs={40}>
          <div className="colophon">
            {points.map((point) => (
              <article key={point.title}>
                <h3>{point.title}</h3>
                <p>{point.body}</p>
              </article>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
