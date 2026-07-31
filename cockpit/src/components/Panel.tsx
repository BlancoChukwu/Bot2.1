import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, children, className = "" }: PanelProps) {
  return (
    <section className={`relative ${className}`}>
      <header className="mb-3 px-1 font-mono text-lg font-bold tracking-[0.12em] text-white uppercase underline decoration-white/80 underline-offset-4 sm:text-xl">
        {title}
      </header>
      <div className="text-[13px] leading-relaxed sm:text-sm">{children}</div>
    </section>
  );
}
