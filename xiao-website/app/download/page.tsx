import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle, Code, DownloadSimple, Warning } from "@phosphor-icons/react/dist/ssr";
import { CopyCommand } from "@/components/CopyCommand";
import { DownloadPanel } from "@/components/DownloadPanel";
import { PageHero } from "@/components/PageHero";
import { installCommand } from "@/lib/site";

export const metadata: Metadata = { title: "Download", description: "Download the Xiao Workbench Windows beta or build it from source." };

export default function DownloadPage() {
  return (
    <>
      <PageHero eyebrow="Release desk" title="Bring Xiao to the desktop." description="A free, open-source Windows beta. Bring a signed-in Codex CLI." />
      <section className="shell download-layout">
        <DownloadPanel />
        <aside className="requirements-card">
          <h2>Before you install</h2>
          <ul className="check-list compact">
            <li><CheckCircle size={20} weight="fill" /> Windows 10 or 11 on x64</li>
            <li><CheckCircle size={20} weight="fill" /> Codex CLI installed and signed in</li>
            <li><CheckCircle size={20} weight="fill" /> Internet for Codex and the browser</li>
          </ul>
          <Link className="text-link" href="/docs#install">Read the install notes <ArrowRight size={16} weight="bold" /></Link>
        </aside>
      </section>

      <section className="section shell install-steps" id="install">
        <div className="section-title narrow"><h2>Three moves, then work.</h2><p>No Xiao account. No workspace sync. No extra cloud layer.</p></div>
        <ol>
          <li><span><DownloadSimple size={24} /></span><div><strong>Take the latest release</strong><p>Choose the .exe attached to the newest Pre-release in the official repository.</p></div></li>
          <li><span><Warning size={24} /></span><div><strong>Read SmartScreen</strong><p>The beta is not code-signed yet. Run only artifacts attached to Xiao&apos;s GitHub Releases.</p></div></li>
          <li><span><Code size={24} /></span><div><strong>Open one project</strong><p>Start Xiao, choose a code folder, and confirm that the Codex CLI connects.</p></div></li>
        </ol>
      </section>

      <section className="source-build">
        <div className="shell source-build-grid">
          <div><p className="eyebrow">Build from source</p><h2>Inspect every layer.</h2><p>You will need Node.js 20+, stable Rust, and the Windows dependencies for Tauri 2.</p></div>
          <div><CopyCommand command={installCommand} /><p className="command-note">Run inside the repository after cloning it.</p></div>
        </div>
      </section>
    </>
  );
}
