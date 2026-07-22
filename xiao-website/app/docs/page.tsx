import type { Metadata } from "next";
import { CheckCircle, GithubLogo, TerminalWindow, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { CopyCommand } from "@/components/CopyCommand";
import { DocsExplorer } from "@/components/DocsExplorer";
import { PageHero } from "@/components/PageHero";
import { repoUrl } from "@/lib/site";

export const metadata: Metadata = { title: "Field guide", description: "Install, connect Codex, and learn the operating model of Xiao Workbench." };

export default function DocsPage() {
  return (
    <>
      <PageHero eyebrow="Field guide" title="Installation to evidence." description="Short operating notes for getting started and understanding what Xiao does on your machine." />
      <DocsExplorer />

      <section className="section shell guide-section" id="install">
        <div className="guide-index"><span>01</span><strong>Install</strong></div>
        <div className="guide-content">
          <h2>Install Xiao on Windows</h2>
          <p>Download the installer from the official GitHub Releases page. The beta is not code-signed yet, so SmartScreen may appear.</p>
          <div className="callout warning"><WarningCircle size={23} weight="fill" /><div><strong>Verify the source</strong><p>Do not run an installer delivered through a mirror, email, or third-party download page.</p></div></div>
          <ol className="plain-steps"><li>Open the newest release marked Pre-release.</li><li>Download the .exe, or the .msi when one is attached.</li><li>In SmartScreen, choose More info and verify the file name.</li><li>Open Xiao and choose a project folder.</li></ol>
        </div>
      </section>

      <section className="section shell guide-section" id="codex">
        <div className="guide-index"><span>02</span><strong>Codex CLI</strong></div>
        <div className="guide-content">
          <h2>Connect the runtime</h2>
          <p>Xiao does not embed another agent runtime. It talks to the Codex app server installed on your machine.</p>
          <CopyCommand command="npm install -g @openai/codex && codex login" />
          <div className="callout success"><CheckCircle size={23} weight="fill" /><div><strong>Quick check</strong><p>If <code>codex</code> runs in your regular terminal, restart Xiao so it can pick up the updated PATH.</p></div></div>
        </div>
      </section>

      <section className="section shell guide-section" id="workspace">
        <div className="guide-index"><span>03</span><strong>Workspace</strong></div>
        <div className="guide-content">
          <h2>Work inside a boundary</h2>
          <p>The project you open becomes the boundary for files, Git, and the terminal. Read every approval before allowing a sensitive action.</p>
          <div className="mini-specs"><div><TerminalWindow size={22} /><strong>Terminal</strong><span>Native PTY at the project</span></div><div><GithubLogo size={22} /><strong>Git</strong><span>Branches, diffs, and worktrees</span></div></div>
        </div>
      </section>

      <section className="docs-help shell">
        <div><h2>Still blocked?</h2><p>Open an issue with reproduction steps, the expected result, and a screenshot when it helps.</p></div>
        <a className="button primary" href={`${repoUrl}/issues/new`} target="_blank" rel="noreferrer">Ask on GitHub</a>
      </section>
    </>
  );
}
