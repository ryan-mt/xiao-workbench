export const repoUrl = "https://github.com/ryan-mt/xiao-workbench";
export const releaseUrl = `${repoUrl}/releases`;
export const issuesUrl = `${repoUrl}/issues/new`;

export const navItems = [
  { href: "/features", label: "Inside Xiao" },
  { href: "/download", label: "Download" },
  { href: "/docs", label: "Field guide" },
  { href: "/open-source", label: "Open source" },
] as const;

export const installCommand = "npm install && npm run tauri dev";
