"use client";

import { useState } from "react";
import type { Document } from "../page";

interface Props {
  documents: Document[];
  onDelete: (docId: string) => void;
}

export function DocumentList({ documents, onDelete }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (documents.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-[var(--text-secondary)]">No documents yet</p>
        <p className="text-xs text-[var(--text-secondary)] mt-1 opacity-60">Upload files to get started</p>
      </div>
    );
  }

  async function handleDelete(docId: string) {
    try {
      const res = await fetch("/manage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", documentId: docId }),
      });
      if (res.ok) {
        onDelete(docId);
      }
    } catch {}
  }

  return (
    <div className="px-2 py-2 space-y-1">
      {documents.map(doc => (
        <div
          key={doc.id}
          className="px-3 py-2 rounded-md hover:bg-[var(--bg-tertiary)] group"
        >
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-[var(--text-secondary)] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <p className="text-sm truncate flex-1">{doc.name}</p>
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 text-xs transition-opacity shrink-0"
                >
                  &times;
                </button>
              </div>
              <p className="text-xs text-[var(--text-secondary)] opacity-60 mt-0.5">
                {doc.characters > 0 ? `${(doc.characters / 1000).toFixed(1)}k chars` : ""}
              </p>
            </div>
          </div>

          {/* Summary section */}
          {doc.summary && (
            <div
              className="mt-1.5 ml-6 cursor-pointer"
              onClick={() => setExpandedId(expandedId === doc.id ? null : doc.id)}
            >
              <p className={`text-xs text-[var(--text-secondary)] ${expandedId === doc.id ? "" : "line-clamp-2"}`}>
                {doc.summary}
              </p>
              <span className="text-xs text-[var(--accent)] opacity-70 hover:opacity-100">
                {expandedId === doc.id ? "收起" : "展开摘要"}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
