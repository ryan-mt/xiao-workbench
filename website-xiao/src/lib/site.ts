export const site = {
  name: "Xiao Workbench",
  shortName: "Xiao",
  tagline: "A calm desk for noisy agent work.",
  description:
    "Local-first Windows workbench for supervising Codex tasks across projects without turning your screen into a dashboard.",
  repoUrl: "https://github.com/ryan-mt/xiao-workbench",
  releasesUrl: "https://github.com/ryan-mt/xiao-workbench/releases",
  license: "MIT",
  platform: "Windows beta",
} as const;

export type NavItem = {
  href: string;
  label: string;
};

export const navItems: NavItem[] = [
  { href: "#story", label: "Story" },
  { href: "#features", label: "Features" },
  { href: "#flow", label: "Flow" },
  { href: "#preview", label: "Preview" },
];
