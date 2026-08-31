export default function ReaderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen w-full bg-[var(--reader-bg,#0f172a)] text-[var(--reader-text,#f8fafc)] selection:bg-brand-500/30 selection:text-brand-200">
      {children}
    </div>
  );
}
