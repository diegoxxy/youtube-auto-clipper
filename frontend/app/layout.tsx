import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClipForge — Ubah 1 Video Panjang Jadi 10 Shorts Viral",
  description:
    "AI clipping tool: paste link YouTube, dapatkan klip pendek siap upload dengan viral score, subtitle otomatis, dan format 9:16 / 1:1 / 16:9.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}