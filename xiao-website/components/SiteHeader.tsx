"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowDown, List, Moon, Sun, X } from "@phosphor-icons/react";
import { navItems, releaseUrl } from "@/lib/site";

type Theme = "light" | "dark";

export function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const saved = localStorage.getItem("xiao-theme") as Theme | null;
    const next = saved ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }, []);

  useEffect(() => setMenuOpen(false), [pathname]);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("xiao-theme", next);
    setTheme(next);
  }

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="brand" href="/" aria-label="Xiao Workbench, home">
          <Image src="/xiao-mark.png" alt="" width={38} height={38} priority />
          <span>Xiao</span>
          <span className="beta-tag">BETA</span>
        </Link>

        <nav className="desktop-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <Link className={pathname === item.href ? "active" : ""} href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="header-actions">
          <button className="icon-button" type="button" onClick={toggleTheme} aria-label="Toggle color theme">
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <a className="header-download" href={releaseUrl} target="_blank" rel="noreferrer">
            Get beta <ArrowDown size={15} weight="bold" />
          </a>
          <button
            className="menu-button"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X size={22} /> : <List size={22} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav className="mobile-nav shell" id="mobile-navigation" aria-label="Mobile navigation">
          {navItems.map((item) => (
            <Link className={pathname === item.href ? "active" : ""} href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
          <a href={releaseUrl} target="_blank" rel="noreferrer">Get the Windows beta</a>
        </nav>
      )}
    </header>
  );
}
