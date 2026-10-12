"use client";

import { useState } from "react";

interface TemplatePreviewProps {
  onSelect: (template: string) => void;
  onClose: () => void;
}

const TEMPLATES = [
  {
    id: "modern",
    name: "Modern",
    desc: "Bold Centered — White text, center bottom",
    preview: {
      bgColor: "#1a1a1a",
      textColor: "#ffffff",
      fontSize: "45px",
      fontWeight: "bold",
      position: "center",
      sample: "Ini contoh subtitle modern",
    },
  },
  {
    id: "retro",
    name: "Retro",
    desc: "Top-Left Yellow — Classic style",
    preview: {
      bgColor: "#1a1a1a",
      textColor: "#ffff00",
      fontSize: "40px",
      fontWeight: "bold",
      position: "top",
      sample: "Ini contoh subtitle retro",
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    desc: "Bottom White — Clean & simple",
    preview: {
      bgColor: "#1a1a1a",
      textColor: "#ffffff",
      fontSize: "40px",
      fontWeight: "normal",
      position: "bottom",
      sample: "Ini contoh subtitle minimal",
    },
  },
];

export function TemplatePreview({ onSelect, onClose }: TemplatePreviewProps) {
  const [selected, setSelected] = useState("modern");

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-3xl p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white">Pilih Template Subtitle</h2>
            <p className="text-sm text-zinc-400 mt-1">Preview style subtitle yang akan di-burn ke video</p>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center transition"
          >
            <span className="text-zinc-400 text-xl">×</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => setSelected(tpl.id)}
              className={`group relative rounded-2xl overflow-hidden border-2 transition ${
                selected === tpl.id
                  ? "border-purple-500 bg-purple-500/10"
                  : "border-zinc-700 hover:border-zinc-600"
              }`}
            >
              {/* Preview frame (9:16 aspect) */}
              <div
                className="aspect-[9/16] w-full flex items-center justify-center relative"
                style={{ backgroundColor: tpl.preview.bgColor }}
              >
                {/* Sample subtitle positioned */}
                <div
                  className={`absolute left-0 right-0 px-4 ${
                    tpl.preview.position === "top"
                      ? "top-4"
                      : tpl.preview.position === "center"
                      ? "top-1/2 -translate-y-1/2"
                      : "bottom-4"
                  }`}
                >
                  <p
                    className="text-center"
                    style={{
                      color: tpl.preview.textColor,
                      fontSize: "clamp(16px, 4vw, 24px)",
                      fontWeight: tpl.preview.fontWeight as any,
                      textShadow: "2px 2px 4px rgba(0,0,0,0.8)",
                    }}
                  >
                    {tpl.preview.sample}
                  </p>
                </div>

                {/* Checkmark overlay */}
                {selected === tpl.id && (
                  <div className="absolute top-2 right-2 w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-4 bg-zinc-800/50">
                <h3 className="font-bold text-white mb-1">{tpl.name}</h3>
                <p className="text-xs text-zinc-400">{tpl.desc}</p>
              </div>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-semibold transition"
          >
            Batal
          </button>
          <button
            onClick={() => {
              onSelect(selected);
              onClose();
            }}
            className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-500 hover:from-purple-700 hover:to-cyan-600 text-white font-semibold transition"
          >
            Pilih {TEMPLATES.find((t) => t.id === selected)?.name}
          </button>
        </div>
      </div>
    </div>
  );
}
