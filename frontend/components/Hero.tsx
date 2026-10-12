export function Hero() {
  return (
    <header className="relative pt-24 pb-32 px-4 text-center overflow-hidden">
      <nav className="absolute top-0 inset-x-0 mx-auto max-w-5xl px-4 py-5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand to-brand-2 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </span>
          <span className="font-bold text-lg tracking-tight">ClipForge</span>
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <a href="#generate" className="hover:text-white transition">Generate</a>
          <a href="#cara-kerja" className="hidden sm:inline hover:text-white transition">Cara Kerja</a>
        </div>
      </nav>

      <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-tight max-w-3xl mx-auto pt-10">
        Ubah <span className="grad-text">1 video panjang</span>
        <br />
        jadi <span className="grad-text">10 klip viral</span>
      </h1>
      <p className="mt-5 text-lg text-zinc-400 max-w-xl mx-auto">
        Paste link YouTube. AI cari momen terbaik, potong otomatis,
        kasih viral score, subtitle, dan format siap upload — semuanya dalam hitungan menit.
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-2 text-sm text-zinc-400">
        {["🎯 Deteksi momen AI", "🏷️ Viral score", "🧩 Subtitle otomatis", "📱 9:16 / 1:1 / 16:9"].map((t) => (
          <span key={t} className="glass rounded-full px-4 py-2">{t}</span>
        ))}
      </div>

      {/* Cara kerja */}
      <div id="cara-kerja" className="mt-16 grid sm:grid-cols-3 gap-4 max-w-3xl mx-auto text-left">
        {[
          ["1", "Paste link", "Masukkan URL YouTube + brief opsional"],
          ["2", "AI memotong", "Transkrip + analisis audio → momen terbaik"],
          ["3", "Download", "Preview, edit, download siap upload"],
        ].map(([n, t, d]) => (
          <div key={n} className="glass rounded-2xl p-5">
            <span className="text-2xl font-bold grad-text">{n}</span>
            <h3 className="font-semibold mt-2">{t}</h3>
            <p className="text-sm text-zinc-500 mt-1">{d}</p>
          </div>
        ))}
      </div>
    </header>
  );
}