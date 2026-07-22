"use client";

import { FormEvent, useState } from "react";
import { ArrowSquareOut, CheckCircle } from "@phosphor-icons/react";
import { issuesUrl } from "@/lib/site";

export function IssueComposer() {
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const details = String(form.get("details") ?? "").trim();
    const kind = String(form.get("kind") ?? "Feedback");

    if (title.length < 5 || details.length < 20) {
      setError("Use at least 5 characters in the title and 20 in the description.");
      return;
    }

    const params = new URLSearchParams({
      title: `[${kind}] ${title}`,
      body: `${details}\n\n---\nPrepared on xiao-website`,
    });
    setError("");
    setSubmitted(true);
    window.open(`${issuesUrl}?${params.toString()}`, "_blank", "noopener,noreferrer");
  }

  if (submitted) {
    return (
      <div className="form-success" role="status">
        <CheckCircle size={36} weight="fill" />
        <h3>Your draft is open on GitHub</h3>
        <p>Review the content in the new tab, then submit the issue when it is ready.</p>
        <button type="button" onClick={() => setSubmitted(false)}>Prepare another issue</button>
      </div>
    );
  }

  return (
    <form className="issue-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="kind">Issue type</label>
        <select id="kind" name="kind" defaultValue="Bug">
          <option value="Bug">Bug report</option>
          <option value="Feature">Feature request</option>
          <option value="Docs">Documentation</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="title">Title</label>
        <input id="title" name="title" placeholder="What should improve?" minLength={5} required />
      </div>
      <div className="field">
        <label htmlFor="details">Details</label>
        <textarea id="details" name="details" placeholder="What were you doing, what happened, and what did you expect?" rows={6} minLength={20} required />
        <small>Do not include tokens, private paths, or account information in a public issue.</small>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary" type="submit">Prepare GitHub issue <ArrowSquareOut size={18} weight="bold" /></button>
    </form>
  );
}
