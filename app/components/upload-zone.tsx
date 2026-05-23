"use client";

import { useState } from "react";
import type { Document } from "../page";

interface Props {
  onUploadComplete: (doc: Document) => void;
}

export function UploadZone({ onUploadComplete }: Props) {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState("");
  const [dragActive, setDragActive] = useState(false);

  // Binary file extensions that need base64 encoding
  const BINARY_EXTENSIONS = new Set(["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt"]);

  function isBinaryFile(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    return BINARY_EXTENSIONS.has(ext);
  }

  async function readFileContent(file: File): Promise<{ content: string; isBinary: boolean }> {
    if (isBinaryFile(file.name)) {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return { content: btoa(binary), isBinary: true };
    }
    return { content: await file.text(), isBinary: false };
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setIsUploading(true);

    const fileArray = Array.from(files);

    if (fileArray.length > 1) {
      // Batch upload
      setProgress(`Processing ${fileArray.length} files...`);

      const fileData = await Promise.all(
        fileArray.map(async (f) => {
          const { content, isBinary } = await readFileContent(f);
          return { content, filename: f.name, isBinary };
        })
      );

      try {
        const res = await fetch("/batch-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: fileData }),
        });

        if (!res.ok) {
          setProgress("Upload failed");
          setIsUploading(false);
          return;
        }

        // Read SSE stream for progress
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") break;

            try {
              const event = JSON.parse(payload);
              switch (event.type) {
                case "file_start":
                  setProgress(`(${event.index + 1}/${event.total}) ${event.filename}`);
                  break;
                case "file_complete":
                  onUploadComplete({
                    id: event.docId,
                    name: event.filename,
                    summary: event.summary || "",
                    characters: event.characters,
                    uploadedAt: new Date().toISOString(),
                  });
                  break;
              }
            } catch {}
          }
        }
      } catch (e) {
        setProgress("Network error");
        console.error("Batch upload failed:", e);
      }
    } else {
      // Single file upload
      const file = fileArray[0];
      setProgress(`Processing ${file.name}...`);

      try {
        const { content, isBinary } = await readFileContent(file);
        const res = await fetch("/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, filename: file.name, isBinary }),
        });

        if (res.ok) {
          const data = await res.json();
          onUploadComplete({
            id: data.documentId,
            name: file.name,
            summary: data.summary || "",
            characters: data.characters,
            uploadedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.error("Upload failed:", e);
      }
    }

    setIsUploading(false);
    setProgress("");
  }

  return (
    <div className="p-4 border-b border-[var(--border)]">
      <div
        onDragOver={e => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={e => { e.preventDefault(); setDragActive(false); handleFiles(e.dataTransfer.files); }}
        className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer ${
          dragActive ? "border-[var(--accent)] bg-[var(--accent)]/5" : "border-[var(--border)] hover:border-[var(--text-secondary)]"
        }`}
      >
        <input
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.ts,.js,.py,.go,.rs,.java,.pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.tex,.yaml,.yml,.xml,.html"
          onChange={e => handleFiles(e.target.files)}
          className="hidden"
          id="file-upload"
        />
        <label htmlFor="file-upload" className="cursor-pointer">
          {isUploading ? (
            <div>
              <p className="text-sm text-[var(--text-secondary)] animate-pulse">Generating summaries...</p>
              {progress && <p className="text-xs text-[var(--text-secondary)] mt-1">{progress}</p>}
            </div>
          ) : (
            <>
              <svg className="w-8 h-8 mx-auto mb-2 text-[var(--text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="text-xs text-[var(--text-secondary)]">
                Drop files here or click to upload
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-1 opacity-60">
                PDF, Word, Excel, PPT, Markdown, TXT, Code files
              </p>
            </>
          )}
        </label>
      </div>
    </div>
  );
}
