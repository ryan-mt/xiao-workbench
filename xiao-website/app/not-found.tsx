import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr";

export default function NotFound() {
  return <section className="not-found shell"><span>404</span><h1>This page left the workspace.</h1><p>The route does not exist or has moved elsewhere.</p><Link className="button primary" href="/"><ArrowLeft size={18} weight="bold" /> Return home</Link></section>;
}
