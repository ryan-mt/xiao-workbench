import type { ReactNode } from "react";

type PageHeroProps = {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
};

export function PageHero({ eyebrow, title, description, actions }: PageHeroProps) {
  return (
    <section className="page-hero shell">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="page-hero-copy">{description}</p>
      {actions && <div className="hero-actions">{actions}</div>}
    </section>
  );
}
