import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "latin-ext"] });

export const metadata: Metadata = {
  metadataBase: new URL("https://xiao-workbench.vercel.app"),
  title: { default: "Xiao Workbench | A calmer desk for Codex", template: "%s | Xiao Workbench" },
  description: "Xiao keeps Codex, Git, files, terminal, browser, and verification in one local-first Windows workspace.",
  icons: { icon: "/xiao-mark.png", apple: "/xiao-mark.png" },
  openGraph: {
    title: "Xiao Workbench",
    description: "A calm desktop desk for noisy agent work.",
    images: ["/xiao-workbench-preview.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geist.variable} ${geistMono.variable}`}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <SiteHeader />
        <main id="main-content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
