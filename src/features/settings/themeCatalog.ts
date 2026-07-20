export type Theme = "system" | "light" | "dark" | "moss" | "dusk" | "ember";

export type ThemeScheme = "dark" | "light";

export type ThemePreset = {
  id: Theme;
  label: string;
  description: string;
  scheme: ThemeScheme;
  swatches: readonly [string, string, string];
  metaColor: string;
};

export const themePresets = [
  {
    id: "system",
    label: "System",
    description: "Match Windows",
    scheme: "light",
    swatches: ["#f9fafe", "#202128", "#7652d8"],
    metaColor: "#f2f4f8",
  },
  {
    id: "light",
    label: "Paper",
    description: "Warm and clear",
    scheme: "light",
    swatches: ["#f9fafe", "#edf0f6", "#1c1c22"],
    metaColor: "#f2f4f8",
  },
  {
    id: "dark",
    label: "Graphite",
    description: "Neutral low glare",
    scheme: "dark",
    swatches: ["#15151a", "#292a33", "#9a83ea"],
    metaColor: "#15151a",
  },
  {
    id: "moss",
    label: "Moss",
    description: "Sage and ink",
    scheme: "light",
    swatches: ["#edf0e8", "#dfe6db", "#55705d"],
    metaColor: "#e8ece4",
  },
  {
    id: "dusk",
    label: "Dusk",
    description: "Deep blue calm",
    scheme: "dark",
    swatches: ["#101522", "#232c40", "#8298cf"],
    metaColor: "#101522",
  },
  {
    id: "ember",
    label: "Ember",
    description: "Charcoal and copper",
    scheme: "dark",
    swatches: ["#18120f", "#30251f", "#c1845e"],
    metaColor: "#18120f",
  },
] as const satisfies readonly ThemePreset[];

export const normalizeTheme = (value: unknown): Theme =>
  themePresets.some((preset) => preset.id === value) ? value as Theme : "system";

export const resolveTheme = (theme: Theme, prefersDark: boolean) => {
  const id: Exclude<Theme, "system"> = theme === "system"
    ? prefersDark ? "dark" : "light"
    : theme;
  const preset = themePresets.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown Xiao theme: ${id}`);
  return { id, scheme: preset.scheme, metaColor: preset.metaColor };
};
