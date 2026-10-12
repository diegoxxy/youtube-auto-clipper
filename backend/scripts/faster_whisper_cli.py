#!/usr/bin/env python3
# faster-whisper CLI wrapper untuk transcribe.js
import sys
import os
from pathlib import Path
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 2:
        print("Usage: faster_whisper_cli.py <audio_file> [--model tiny] [--output_dir .]")
        sys.exit(1)
    
    audio_file = sys.argv[1]
    model_size = "tiny"
    output_dir = "."
    
    # Parse args
    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--model" and i + 1 < len(sys.argv):
            model_size = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--output_dir" and i + 1 < len(sys.argv):
            output_dir = sys.argv[i + 1]
            i += 2
        else:
            i += 1
    
    # Load model (device auto-detect: CUDA if available, else CPU)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    
    # Transcribe
    segments, info = model.transcribe(audio_file, beam_size=1)
    
    # Write SRT
    base = Path(audio_file).stem
    srt_path = Path(output_dir) / f"{base}.srt"
    
    with open(srt_path, "w", encoding="utf-8") as f:
        idx = 1
        for segment in segments:
            start = format_timestamp(segment.start)
            end = format_timestamp(segment.end)
            text = segment.text.strip()
            f.write(f"{idx}\n{start} --> {end}\n{text}\n\n")
            idx += 1
    
    print(f"[faster-whisper] wrote {srt_path}")

def format_timestamp(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

if __name__ == "__main__":
    main()
