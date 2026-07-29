import { Reveal } from "@/components/Reveal";
import { site } from "@/lib/site";

export function FinalCta() {
  return (
    <section className="band-tight" aria-labelledby="cta-heading">
      <div className="frame">
        <Reveal>
          <div className="endplate">
            <p className="mono">{site.platform}</p>
            <h2
              id="cta-heading"
              className="h-section mt-3 max-w-[12ch] text-[2rem] sm:text-4xl md:text-[2.6rem]"
            >
              Try the Windows beta
            </h2>
            <p className="prose mt-4">
              Grab the newest pre-release installer from GitHub. For live agent
              tasks, install the Codex CLI and sign in first. The installer is
              not code-signed yet, so SmartScreen may ask you to confirm.
            </p>
            <div className="actions">
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
        </Reveal>
      </div>
    </section>
  );
}
