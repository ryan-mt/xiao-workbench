import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle,
  Code,
  FolderOpen,
  GithubLogo,
  ListChecks,
  TerminalWindow,
  TreeStructure,
} from "@phosphor-icons/react/dist/ssr";
import { releaseUrl, repoUrl } from "@/lib/site";

const capabilities = [
  { icon: Code, title: "The task stays central", body: "Conversation, plans, tool activity, and approvals share one readable timeline." },
  { icon: FolderOpen, title: "Context stays attached", body: "Files, diffs, and history remain tied to the workspace you opened." },
  { icon: TerminalWindow, title: "Tools wait off-stage", body: "A native terminal and browser slide in without replacing the work." },
  { icon: ListChecks, title: "Done comes with proof", body: "Acceptance gates and evidence make the result inspectable before you keep it." },
];

export default function Home() {
  return (
    <>
      <section className="home-hero shell">
        <div className="home-hero-copy">
          <p className="eyebrow">Field note 001 · Windows beta</p>
          <h1>Agent work,<br />without the noise.</h1>
          <p>Xiao keeps Codex and the tools around it on one calm, local desktop.</p>
          <div className="hero-actions">
            <a className="button primary" href={releaseUrl} target="_blank" rel="noreferrer">Get the beta <ArrowRight size={18} weight="bold" /></a>
            <a className="button secondary" href={repoUrl} target="_blank" rel="noreferrer"><GithubLogo size={18} weight="fill" /> Read the code</a>
          </div>
        </div>
        <figure className="hero-product">
          <div className="window-frame">
            <div className="window-bar"><span></span><span></span><span></span><small>Xiao · New task</small></div>
            <Image src="/xiao-depth-engine.png" alt="New task screen in Xiao Workbench" width={1586} height={992} priority sizes="(max-width: 900px) 100vw, 68vw" />
          </div>
          <figcaption>New task · local workspace · beta build</figcaption>
        </figure>
      </section>

      <section className="fact-strip" aria-label="Product facts">
        <div className="shell fact-grid">
          <span><strong>Local-first</strong> Runtime on your machine</span>
          <span><strong>Open source</strong> MIT License</span>
          <span><strong>Windows</strong> Desktop beta</span>
          <span><strong>No Xiao telemetry</strong> Nothing extra watching</span>
        </div>
      </section>

      <section className="section shell">
        <div className="section-title narrow">
          <h2>One task. Everything around it.</h2>
          <p>Xiao does not turn the whole screen into a dashboard. It reveals tools only when the work calls for them.</p>
        </div>
        <div className="capability-mosaic">
          {capabilities.map(({ icon: Icon, title, body }, index) => (
            <article className={`mosaic-card card-${index + 1}`} key={title}>
              <Icon size={29} weight="duotone" aria-hidden="true" />
              <div><h3>{title}</h3><p>{body}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="section workflow-section">
        <div className="shell workflow-grid">
          <div className="workflow-copy">
            <h2>Prompt to proof.</h2>
            <p>A legible path through the work, with a human still making the decisions.</p>
            <Link className="text-link" href="/features">Open the workbench <ArrowRight size={17} weight="bold" /></Link>
          </div>
          <ol className="workflow-steps">
            <li><span>01</span><div><h3>Open a workspace</h3><p>Give files, Git, and the terminal a clear project boundary.</p></div></li>
            <li><span>02</span><div><h3>Hand Codex the task</h3><p>Follow the plan, tool activity, and approvals while work is moving.</p></div></li>
            <li><span>03</span><div><h3>Inspect what survived</h3><p>Read the diff, run the gates, and review the evidence before keeping it.</p></div></li>
          </ol>
        </div>
      </section>

      <section className="section shell local-section">
        <div className="local-visual">
          <Image src="/xiao-local-first.png" alt="Xiao mascot beside a laptop and local storage drive" width={1484} height={1060} sizes="(max-width: 800px) 100vw, 100vw" />
        </div>
        <div className="local-copy">
          <p className="eyebrow">Local by design</p>
          <h2>Your work stays close.</h2>
          <p>Xiao talks to the Codex app server installed on your computer. It does not hide another runtime behind a remote web app.</p>
          <ul className="check-list">
            <li><CheckCircle size={21} weight="fill" /> Workspace and Git actions stay scoped to the project.</li>
            <li><CheckCircle size={21} weight="fill" /> Xiao adds no analytics or telemetry of its own.</li>
            <li><CheckCircle size={21} weight="fill" /> The MIT-licensed source is open to inspect and build.</li>
          </ul>
        </div>
      </section>

      <section className="section shell open-callout">
        <div>
          <TreeStructure size={38} weight="duotone" />
          <h2>Built in the open.</h2>
        </div>
        <div>
          <p>Follow the work through commits, report friction in issues, and send focused changes to the dev branch.</p>
          <Link className="button secondary" href="/open-source">Enter the project <ArrowRight size={18} weight="bold" /></Link>
        </div>
      </section>
    </>
  );
}
