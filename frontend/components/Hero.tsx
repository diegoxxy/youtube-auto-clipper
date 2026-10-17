export function Hero() {
  return (
    <header className="relative pt-20 pb-24 px-4 text-center">
      <nav className="absolute top-0 inset-x-0 mx-auto max-w-6xl px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="font-semibold text-base text-text">ClipForge</span>
        </div>
        <div className="flex items-center gap-6 text-sm text-text-secondary">
          <a href="#generate" className="hover:text-text transition-colors">Generate</a>
          <a href="#cara-kerja" className="hidden sm:inline hover:text-text transition-colors">Cara Kerja</a>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto pt-16">
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-text leading-tight">
          Ubah 1 video panjang<br />jadi 10 klip viral
        </h1>
        <p className="mt-6 text-lg text-text-secondary max-w-2xl mx-auto">
          Paste link YouTube. AI cari momen terbaik, potong otomatis,
          kasih viral score, subtitle, dan format siap upload.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-2 text-sm">
          {["🎯 Deteksi momen AI", "🏷️ Viral score", "🧩 Subtitle otomatis", "📱 9:16 / 1:1 / 16:9"].map((t) => (
            <span key={t} className="card px-4 py-2 text-text-secondary">
              {t}
            </span>
          ))}
        </div>
      </div>

      <div id="cara-kerja" className="mt-20 grid sm:grid-cols-3 gap-4 max-w-4xl mx-auto text-left">
        {[
          ["01", "Paste link", "Masukkan URL YouTube + brief opsional"],
          ["02", "AI memotong", "Transkrip + analisis audio → momen terbaik"],
          ["03", "Download", "Preview, edit, download siap upload"],
        ].map(([n, t, d]) => (
          <div key={n} className="card p-6 hover:border-border-focus transition-colors">
            <div className="text-2xl font-bold text-text-tertiary mb-3">{n}</div>
            <h3 className="font-semibold text-text mb-2">{t}</h3>
            <p className="text-sm text-text-secondary leading-relaxed">{d}</p>
          </div>
        ))}
      </div>
    </header>
  );
}
