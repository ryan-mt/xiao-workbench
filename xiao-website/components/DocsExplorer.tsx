"use client";

import { useMemo, useState } from "react";
import { ArrowRight, MagnifyingGlass } from "@phosphor-icons/react";

type Doc = {
  category: string;
  title: string;
  description: string;
  href: string;
};

const docs: Doc[] = [
  { category: "Start", title: "Install Xiao", description: "Download the beta, read SmartScreen safely, and open the first workspace.", href: "#install" },
  { category: "Start", title: "Connect Codex CLI", description: "Install the CLI, sign in, and confirm the app server on your machine.", href: "#codex" },
  { category: "Workspace", title: "Open a project", description: "How Xiao scopes files, Git, and terminal work to the chosen folder.", href: "#workspace" },
  { category: "Workspace", title: "Focus Rail", description: "Inspect files, diffs, terminal, and browser without leaving the task.", href: "#focus-rail" },
  { category: "Workflow", title: "Plans and approvals", description: "Follow the plan, review actions, and respond inside the work stream.", href: "#workflow" },
  { category: "Workflow", title: "Verification evidence", description: "Set acceptance gates and inspect evidence before completion.", href: "#verification" },
  { category: "Recovery", title: "Codex will not connect", description: "Check the CLI, account, PATH, and app server in order.", href: "#troubleshooting" },
  { category: "Recovery", title: "Windows SmartScreen", description: "Verify the official beta artifact before running the installer.", href: "#smartscreen" },
];

export function DocsExplorer() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const categories = ["All", ...Array.from(new Set(docs.map((doc) => doc.category)))];

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("vi");
    return docs.filter((doc) => {
      const matchesCategory = category === "All" || doc.category === category;
      const haystack = `${doc.title} ${doc.description} ${doc.category}`.toLocaleLowerCase("vi");
      return matchesCategory && (!normalized || haystack.includes(normalized));
    });
  }, [category, query]);

  return (
    <section className="docs-explorer shell" aria-labelledby="browse-docs">
      <div className="docs-heading">
        <h2 id="browse-docs">Search by intent</h2>
        <p>Describe what you are trying to do. You do not need the feature name.</p>
      </div>
      <label className="search-box">
        <span className="sr-only">Search the field guide</span>
        <MagnifyingGlass size={21} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Try: connect Codex, terminal, approvals..." />
      </label>
      <div className="filter-row" aria-label="Filter guide entries">
        {categories.map((item) => (
          <button className={category === item ? "selected" : ""} type="button" onClick={() => setCategory(item)} key={item}>
            {item}
          </button>
        ))}
      </div>
      {filtered.length ? (
        <div className="doc-grid">
          {filtered.map((doc) => (
            <a className="doc-card" href={doc.href} key={doc.title}>
              <span>{doc.category}</span>
              <h3>{doc.title}</h3>
              <p>{doc.description}</p>
              <ArrowRight size={19} weight="bold" />
            </a>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <MagnifyingGlass size={28} />
          <h3>No matching field note</h3>
          <p>Try a shorter phrase or return to “All”.</p>
          <button type="button" onClick={() => { setQuery(""); setCategory("All"); }}>Clear filters</button>
        </div>
      )}
    </section>
  );
}
