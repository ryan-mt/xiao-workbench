import Image from "next/image";

import { site } from "@/lib/site";

export function Hero() {
  return (
    <section id="top" className="band" aria-labelledby="hero-heading">
      <div className="frame">
        <p className="mono">
          {site.platform} / local-first / codex-native
        </p>

        <h1
          id="hero-heading"
          className="h-poster mt-5 max-w-[11ch] text-[3.1rem] sm:text-6xl md:text-[5.1rem] lg:text-[5.6rem]"
        >
          A calm desk for noisy agent work
        </h1>

        <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:items-end">
          <p className="prose">
            Xiao Workbench keeps Codex conversation in the middle. Plan, files,
            diffs, terminal, and browser stay close enough to reach without
            turning the screen into a dashboard.
          </p>
          <div className="flex flex-wrap gap-2.5 md:justify-end">
            <a
              href={site.releasesUrl}
              className="btn btn-lg"
              target="_blank"
              rel="noopener noreferrer"
            >
              Download Windows beta
            </a>
            <a
              href={site.repoUrl}
              className="btn btn-line btn-lg"
              target="_blank"
              rel="noopener noreferrer"
            >
              View source
            </a>
          </div>
        </div>

        <figure className="mt-12 md:mt-14">
          <div className="specimen">
            <Image
              src="/screenshots/sidebar.png"
              alt="Xiao Workbench with projects sidebar and new task composer"
              width={1600}
              height={1000}
              priority
              sizes="100vw"
            />
            <div className="specimen-meta">
              <span>Fig. workbench</span>
              <span>Windows beta capture</span>
            </div>
          </div>
        </figure>
      </div>
    </section>
  );
}
