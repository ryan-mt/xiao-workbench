import Image from "next/image";

import { site } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="foot">
      <div className="frame foot-inner">
        <div className="max-w-md">
          <div className="mark">
            <Image
              src="/xiao-mark.png"
              alt=""
              width={22}
              height={22}
              className="size-[22px]"
            />
            <span>{site.name}</span>
          </div>
          <p className="mt-2.5 text-sm leading-relaxed text-mute">
            Open-source under the {site.license} License. Built with Tauri,
            Rust, React, and TypeScript for Codex Operators on Windows.
          </p>
        </div>

        <nav className="foot-nav" aria-label="Footer">
          <a
            href={site.releasesUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Releases
          </a>
          <a href={site.repoUrl} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a
            href={`${site.repoUrl}/blob/dev/LICENSE`}
            target="_blank"
            rel="noopener noreferrer"
          >
            License
          </a>
          <a
            href={`${site.repoUrl}/blob/dev/CONTRIBUTING.md`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Contributing
          </a>
        </nav>
      </div>
    </footer>
  );
}
