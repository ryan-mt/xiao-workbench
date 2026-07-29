import { Difference } from "@/components/Difference";
import { Features } from "@/components/Features";
import { FinalCta } from "@/components/FinalCta";
import { Flow } from "@/components/Flow";
import { Hero } from "@/components/Hero";
import { Preview } from "@/components/Preview";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { Story } from "@/components/Story";

export default function Home() {
  return (
    <div className="site">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main">
        <Hero />
        <hr className="rule frame" />
        <Story />
        <Features />
        <Flow />
        <Preview />
        <Difference />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
