import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Browser,
  CheckCircle,
  ClockCountdown,
  GitBranch,
  ShieldCheck,
  TerminalWindow,
} from "@phosphor-icons/react/dist/ssr";
import { PageHero } from "@/components/PageHero";

export const metadata: Metadata = { title: "Inside Xiao", description: "Explore the task timeline, Focus Rail, terminal, browser, Git, and verification inside Xiao Workbench." };

const focusTools = [
  { icon: TerminalWindow, title: "Native terminal", body: "Run real commands in a PTY attached to the current workspace." },
  { icon: Browser, title: "Research browser", body: "Keep references and ordinary web pages beside the task." },
  { icon: GitBranch, title: "Git and worktrees", body: "Inspect branches and diffs, then isolate parallel work on purpose." },
  { icon: ClockCountdown, title: "Routines and history", body: "Return to previous runs and organize repeatable work by project." },
];

const faqs = [
  ["Does Xiao replace the Codex CLI?", "No. Xiao uses the Codex app server on your machine and builds a visual desktop workspace around that runtime."],
  ["Does Xiao work completely offline?", "Files, Git, and the terminal are local. Codex tasks and the browser still depend on their respective services."],
  ["What about macOS and Linux?", "The public beta currently focuses on Windows. Follow the repository for platform work as it develops."],
  ["Does Xiao upload workspace data?", "Xiao adds no analytics or telemetry of its own. Codex and websites still follow their account settings and policies."],
];

export default function FeaturesPage() {
  return (
    <>
      <PageHero eyebrow="Anatomy of the workbench" title="The tools move. The task stays." description="A workspace organized around the thread of work, not the number of panels." actions={<Link className="button primary" href="/download">Get the beta <ArrowRight size={18} weight="bold" /></Link>} />

      <section className="feature-showcase shell">
        <div className="showcase-copy">
          <span className="feature-number">01</span>
          <h2>The timeline keeps the full story.</h2>
          <p>Prompts, plans, tool activity, approvals, and follow-ups appear in the order they happened.</p>
          <ul className="check-list compact">
            <li><CheckCircle size={20} weight="fill" /> Live task streaming</li>
            <li><CheckCircle size={20} weight="fill" /> Approvals in context</li>
            <li><CheckCircle size={20} weight="fill" /> Plans attached to the conversation</li>
          </ul>
        </div>
        <div className="showcase-image"><Image src="/xiao-focus-lens.png" alt="Focused task interface in Xiao" width={1586} height={992} /></div>
      </section>

      <section className="section focus-rail-section">
        <div className="shell">
          <div className="section-title narrow"><h2>A rail, not a dashboard.</h2><p>Bring in the one tool this moment needs, then return without reconstructing the context.</p></div>
          <div className="focus-tools">
            {focusTools.map(({ icon: Icon, title, body }) => (
              <article key={title}><Icon size={27} weight="duotone" /><h3>{title}</h3><p>{body}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className="feature-showcase reverse shell">
        <div className="showcase-copy">
          <span className="feature-number">03</span>
          <h2>“Done” needs evidence.</h2>
          <p>State the expected result, run the checks that matter, and inspect artifacts or failures beside the task.</p>
          <div className="evidence-chip"><ShieldCheck size={24} weight="fill" /><span><strong>Evidence attached</strong> Acceptance gate passed</span></div>
        </div>
        <div className="showcase-image"><Image src="/xiao-instrument-mode.png" alt="Instrument mode in Xiao Workbench" width={1586} height={992} /></div>
      </section>

      <section className="section shell faq-section">
        <div className="section-title"><h2>Operating notes</h2></div>
        <div className="faq-list">
          {faqs.map(([question, answer]) => <details key={question}><summary>{question}<span>+</span></summary><p>{answer}</p></details>)}
        </div>
      </section>
    </>
  );
}
