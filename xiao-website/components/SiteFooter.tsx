import Image from "next/image";
import Link from "next/link";
import { GithubLogo } from "@phosphor-icons/react/dist/ssr";
import { navItems, repoUrl } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div className="footer-brand">
          <Image src="/xiao-mark.png" alt="" width={42} height={42} />
          <div>
            <strong>Xiao Workbench</strong>
            <p>A calm desktop desk for noisy agent work.</p>
          </div>
        </div>
        <div className="footer-links">
          <span>Explore</span>
          {navItems.map((item) => <Link href={item.href} key={item.href}>{item.label}</Link>)}
        </div>
        <div className="footer-links">
          <span>Project</span>
          <a href={repoUrl} target="_blank" rel="noreferrer">GitHub</a>
          <a href={`${repoUrl}/issues`} target="_blank" rel="noreferrer">Issues</a>
          <a href={`${repoUrl}/blob/dev/CONTRIBUTING.md`} target="_blank" rel="noreferrer">Contribute</a>
        </div>
      </div>
      <div className="shell footer-bottom">
        <span>© 2026 Xiao Workbench. MIT License.</span>
        <span className="built-with"><GithubLogo size={16} weight="fill" /> Tauri · Rust · React · TypeScript</span>
      </div>
    </footer>
  );
}
