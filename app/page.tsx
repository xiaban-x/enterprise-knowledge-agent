"use client";

import { useState, useEffect } from "react";
import { DocumentList } from "./components/document-list";
import { UploadZone } from "./components/upload-zone";
import { ChatPanel } from "./components/chat-panel";

export interface Document {
  id: string;
  name: string;
  summary: string;
  characters: number;
  uploadedAt: string;
}

export default function Page() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Load existing documents on mount
  useEffect(() => {
    async function loadDocs() {
      try {
        const res = await fetch("/manage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list" }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.documents) {
            setDocuments(data.documents.map((d: any) => ({
              id: d.docId,
              name: d.filename,
              summary: d.summary || "",
              characters: d.charCount || 0,
              uploadedAt: d.uploadedAt || "",
            })));
          }
        }
      } catch {}
    }
    loadDocs();
  }, []);

  function handleUploadComplete(doc: Document) {
    setDocuments(prev => [...prev, doc]);
  }

  function handleDelete(docId: string) {
    setDocuments(prev => prev.filter(d => d.id !== docId));
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      {sidebarOpen && (
        <aside className="w-80 flex flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <h2 className="text-sm font-semibold">Knowledge Base</h2>
            <button
              onClick={() => setSidebarOpen(false)}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-lg"
            >
              &times;
            </button>
          </div>

          <UploadZone onUploadComplete={handleUploadComplete} />

          <div className="flex-1 overflow-auto">
            <DocumentList documents={documents} onDelete={handleDelete} />
          </div>

          <div className="px-4 py-2 border-t border-[var(--border)] text-xs text-[var(--text-secondary)]">
            {documents.length} documents indexed
          </div>
        </aside>
      )}

      {/* Main chat area */}
      <main className="flex-1 flex flex-col">
        <header className="flex items-center gap-3 px-6 py-3 border-b border-[var(--border)]">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
          <h1 className="text-lg font-semibold">RAG Knowledge Base</h1>
          <span className="text-xs px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded">On-Demand Retrieval</span>
        </header>

        <ChatPanel />
      </main>
    </div>
  );
}
