import Image from "next/image";

import { Reveal } from "@/components/Reveal";

const shots = [
  {
    src: "/screenshots/settings.png",
    alt: "Settings with theme and workspace preferences",
    fig: "Fig. settings",
    note: "Themes: light / dark / system",
  },
  {
    src: "/screenshots/profile.png",
    alt: "Local profile for on-device identity",
    fig: "Fig. profile",
    note: "Local identity on the host",
  },
] as const;

export function Preview() {
  return (
    <section id="preview" className="band" aria-labelledby="preview-heading">
      <div className="frame">
        <Reveal className="mb-10 max-w-2xl">
          <p className="mono">Contact sheet</p>
          <h2
            id="preview-heading"
            className="h-section mt-3 text-[2.2rem] sm:text-5xl md:text-[3.2rem]"
          >
            More of the workbench
          </h2>
          <p className="prose mt-4">
            Additional captures from the Windows UI.
          </p>
        </Reveal>

        <div className="sheet">
          {shots.map((shot, index) => (
            <Reveal key={shot.src} delayMs={index * 45} as="figure">
              <div className="specimen">
                <Image
                  src={shot.src}
                  alt={shot.alt}
                  width={1600}
                  height={1000}
                  sizes="(max-width: 800px) 100vw, 50vw"
                />
                <div className="specimen-meta">
                  <span>{shot.fig}</span>
                  <span>{shot.note}</span>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
