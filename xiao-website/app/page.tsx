import Image from "next/image";
import {
  ArrowDown,
  ArrowRight,
  CheckCircle,
  ClockCountdown,
  Code,
  FolderOpen,
  GithubLogo,
  ListChecks,
  TerminalWindow,
  TreeStructure,
} from "@phosphor-icons/react/dist/ssr";

const repoUrl = "https://github.com/ryan-mt/xiao-workbench";
const releaseUrl = `${repoUrl}/releases`;

const outcomes = [
  {
    icon: Code,
    title: "Follow the whole task",
    body: "Conversation, tool activity, approvals, plans, and follow-ups stay in one readable timeline.",
  },
  {
    icon: TerminalWindow,
    title: "Keep tools within reach",
    body: "Open files, diffs, a real terminal, and the browser without replacing the task in front of you.",
  },
  {
    icon: ListChecks,
    title: "Review before done",
    body: "Attach acceptance gates and evidence to the work so completion is something you can inspect.",
  },
];

const workbenchItems = [
  {
    icon: FolderOpen,
    title: "Files and changes",
    body: "Read project files, inspect diffs, and keep every action scoped to the workspace you opened.",
  },
  {
    icon: TerminalWindow,
    title: "Terminal and browser",
    body: "Use a native terminal and open references beside the task instead of switching to another app.",
  },
  {
    icon: TreeStructure,
    title: "Branches and worktrees",
    body: "Give parallel work an isolated Git worktree while keeping its relationship to the main project clear.",
  },
  {
    icon: ClockCountdown,
    title: "Routines and history",
    body: "Schedule repeatable work, return to completed runs, and keep handoffs organized by project.",
  },
];

const workflow = [
  {
    icon: FolderOpen,
    title: "Open a project",
    body: "Xiao scopes files, Git, and terminal work to the folder you choose.",
  },
  {
    icon: Code,
    title: "Ask Codex",
    body: "Start a task and follow the conversation, plan, and tool activity as it happens.",
  },
  {
    icon: CheckCircle,
    title: "Review and ship",
    body: "Inspect changes and verification evidence before you keep the result.",
  },
];

export default function Home() {
  return (
    <main>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="Xiao home">
          <Image src="/xiao-mark.png" alt="" width={38} height={38} priority />
          <span>Xiao</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#inside">Inside Xiao</a>
          <a href="#workbench">Workbench</a>
          <a href="#principles">Why local</a>
          <a className="nav-download" href={releaseUrl} target="_blank" rel="noreferrer">
            Download
            <ArrowDown size={15} weight="bold" />
          </a>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Local Codex workspace for Windows</p>
          <h1>Keep the task in focus.</h1>
          <p className="hero-lede">
            Xiao keeps Codex, Git, files, terminal, browser, and verification together on your machine.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={releaseUrl} target="_blank" rel="noreferrer">
              Download for Windows
              <ArrowDown size={18} weight="bold" />
            </a>
            <a className="button button-quiet" href={repoUrl} target="_blank" rel="noreferrer">
              <GithubLogo size={18} weight="fill" />
              View source
            </a>
          </div>
        </div>

        <figure className="product-visual">
          <div className="product-frame">
            <Image
              src="/xiao-workbench-preview.png"
              alt="Xiao Workbench interface with a focused task composer and local workspace controls"
              width={1440}
              height={900}
              priority
              sizes="(max-width: 820px) 100vw, 58vw"
            />
          </div>
          <figcaption>Interface preview. Live tasks run in the native app.</figcaption>
        </figure>
      </section>

      <section className="proof shell" aria-label="Xiao product principles">
        <p>Built for a quieter way to work.</p>
        <div className="proof-items">
          <span>Windows desktop</span>
          <span>Local-first</span>
          <span>MIT open source</span>
          <span>No Xiao telemetry</span>
        </div>
      </section>

      <section className="outcomes shell section" id="inside">
        <div className="section-heading">
          <h2>One task. Everything around it.</h2>
          <p>
            Xiao keeps the work centered while the supporting tools stay close enough to open when you need them.
          </p>
        </div>
        <div className="outcome-grid">
          {outcomes.map(({ icon: Icon, title, body }, index) => (
            <article className={`outcome outcome-${index + 1}`} key={title}>
              <Icon size={28} weight="duotone" aria-hidden="true" />
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="workbench shell section" id="workbench">
        <div className="workbench-heading">
          <h2>The tools move. The task stays.</h2>
          <p>
            The Focus Rail opens beside the conversation, so checking a diff or running a command never hides the work.
          </p>
        </div>
        <div className="capability-list">
          {workbenchItems.map(({ icon: Icon, title, body }) => (
            <article className="capability" key={title}>
              <Icon size={25} weight="duotone" aria-hidden="true" />
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="verification section">
        <div className="shell verification-layout">
          <div className="verification-mark" aria-hidden="true">
            <CheckCircle size={112} weight="duotone" />
            <span>Evidence attached</span>
          </div>
          <div className="verification-copy">
            <h2>Done should mean checked.</h2>
            <p>
              Define the expected result, run the checks that matter, and review the evidence beside the task.
            </p>
            <div className="verification-points">
              <span>Set acceptance gates</span>
              <span>Run project checks</span>
              <span>Inspect artifacts and failures</span>
            </div>
          </div>
        </div>
      </section>

      <section className="local shell section" id="principles">
        <div className="local-media">
          <Image
            src="/xiao-local-first.png"
            alt="Xiao mushroom mascot beside a laptop, project folder, and local storage drive"
            width={1484}
            height={1060}
            sizes="(max-width: 820px) 100vw, 52vw"
          />
        </div>
        <div className="local-copy">
          <h2>Local by design.</h2>
          <p>
            Xiao connects to the Codex app server installed on your computer. It does not add another remote agent runtime.
          </p>
          <div className="principles" role="list">
            <div role="listitem">
              <CheckCircle size={21} weight="fill" />
              <span>Workspace and Git actions stay scoped to the project you opened.</span>
            </div>
            <div role="listitem">
              <CheckCircle size={21} weight="fill" />
              <span>Xiao adds no analytics or telemetry of its own.</span>
            </div>
            <div role="listitem">
              <CheckCircle size={21} weight="fill" />
              <span>The MIT-licensed source is open for inspection.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="flow shell section" id="workflow">
        <div className="section-heading flow-heading">
          <h2>From prompt to proof.</h2>
          <p>Start with the project. Stay with the task. Keep only what survives review.</p>
        </div>
        <div className="flow-grid">
          {workflow.map(({ icon: Icon, title, body }) => (
            <article className="flow-item" key={title}>
              <Icon size={25} weight="duotone" aria-hidden="true" />
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="download shell section" id="download" aria-label="Download Xiao">
        <div className="download-intro">
          <p className="eyebrow">Windows beta</p>
          <h2>Make room for the work.</h2>
          <p>
            Install Xiao, sign in through the Codex CLI, and open the project you want to work on.
          </p>
          <div className="download-actions">
            <a className="button button-primary" href={releaseUrl} target="_blank" rel="noreferrer">
              Download for Windows
              <ArrowDown size={18} weight="bold" />
            </a>
            <a className="text-link" href={repoUrl} target="_blank" rel="noreferrer">
              Read the source
              <ArrowRight size={16} weight="bold" />
            </a>
          </div>
        </div>
        <div className="requirements">
          <article>
            <span>Platform</span>
            <strong>Windows desktop</strong>
          </article>
          <article>
            <span>Agent runtime</span>
            <strong>Codex CLI, signed in</strong>
          </article>
          <article>
            <span>License</span>
            <strong>MIT open source</strong>
          </article>
          <article>
            <span>Installer</span>
            <strong>Code signing is coming</strong>
          </article>
          <p className="installer-note">
            Windows SmartScreen may ask you to confirm the unsigned beta installer. Use only files attached to this repository&apos;s releases.
          </p>
        </div>
      </section>

      <footer className="site-footer shell">
        <span>Xiao Workbench</span>
        <span>Built with Tauri, Rust, React, and TypeScript.</span>
        <a href={repoUrl} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </footer>
    </main>
  );
}
