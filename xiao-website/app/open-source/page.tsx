import type { Metadata } from "next";
import { ArrowSquareOut, Code, GitBranch, GithubLogo, Heart, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import { IssueComposer } from "@/components/IssueComposer";
import { PageHero } from "@/components/PageHero";
import { repoUrl } from "@/lib/site";

export const metadata: Metadata = { title: "Open source", description: "Inspect the source, contribute, and send feedback to Xiao Workbench." };

const principles = [
  { icon: Code, title: "MIT licensed", body: "Read it, change it, build it, and learn from the codebase under the MIT terms." },
  { icon: GitBranch, title: "Public development", body: "Active work happens on the dev branch, and pull requests return there." },
  { icon: ShieldCheck, title: "No Xiao telemetry", body: "There is no private analytics layer watching how you work." },
];

export default function OpenSourcePage() {
  return (
    <>
      <PageHero eyebrow="Open source" title="No second black box." description="Xiao is built with Tauri, Rust, React, and TypeScript, with source you can inspect." actions={<a className="button primary" href={repoUrl} target="_blank" rel="noreferrer"><GithubLogo size={19} weight="fill" /> Open repository</a>} />

      <section className="shell principle-grid">
        {principles.map(({ icon: Icon, title, body }) => <article key={title}><Icon size={28} weight="duotone" /><h2>{title}</h2><p>{body}</p></article>)}
      </section>

      <section className="section contribute-section">
        <div className="shell contribute-grid">
          <div className="contribute-copy"><Heart size={36} weight="duotone" /><h2>A clear path into the code.</h2><p>Fork the repository, branch from <code>dev</code>, run the checks, and send the pull request back to <code>dev</code>.</p><a className="text-link" href={`${repoUrl}/blob/dev/CONTRIBUTING.md`} target="_blank" rel="noreferrer">Read CONTRIBUTING.md <ArrowSquareOut size={16} weight="bold" /></a></div>
          <div className="contribute-steps"><span>01 <strong>Fork and branch</strong></span><span>02 <strong>Keep the change focused</strong></span><span>03 <strong>Run checks and tests</strong></span><span>04 <strong>Open the pull request</strong></span></div>
        </div>
      </section>

      <section className="section shell feedback-layout">
        <div><p className="eyebrow">Feedback hatch</p><h2>Tell us where Xiao gets in the way.</h2><p>This form prepares a GitHub issue for you to review. The website stores none of the content.</p></div>
        <IssueComposer />
      </section>
    </>
  );
}
