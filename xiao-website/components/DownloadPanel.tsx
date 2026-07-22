"use client";

import { useEffect, useState } from "react";
import { ArrowDown, GithubLogo, WindowsLogo } from "@phosphor-icons/react";
import { releaseUrl, repoUrl } from "@/lib/site";

export function DownloadPanel() {
  const [isWindows, setIsWindows] = useState<boolean | null>(null);

  useEffect(() => {
    setIsWindows(navigator.userAgent.toLowerCase().includes("windows"));
  }, []);

  return (
    <div className="download-panel">
      <div className="platform-row">
        <span className="platform-icon"><WindowsLogo size={30} weight="fill" /></span>
        <div>
          <span className="status-label">Current public build</span>
          <h2>Windows beta</h2>
          <p>An .exe installer, with an .msi package when available.</p>
        </div>
      </div>
      {isWindows === false && (
        <p className="notice">This device is not running Windows. You can still inspect and build Xiao from source.</p>
      )}
      <div className="download-panel-actions">
        <a className="button primary" href={releaseUrl} target="_blank" rel="noreferrer">
          View latest release <ArrowDown size={18} weight="bold" />
        </a>
        <a className="button secondary" href={repoUrl} target="_blank" rel="noreferrer">
          <GithubLogo size={18} weight="fill" /> Source code
        </a>
      </div>
      <div className="release-facts">
        <span><strong>Architecture</strong> x64</span>
        <span><strong>License</strong> MIT</span>
        <span><strong>Updates</strong> GitHub Releases</span>
      </div>
    </div>
  );
}
