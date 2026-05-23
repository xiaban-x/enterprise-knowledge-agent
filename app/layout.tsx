import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RAG Knowledge Base - EdgeOne Pages",
  description: "AI-powered knowledge base with document upload and intelligent Q&A",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg-primary)]">{children}</body>
    </html>
  );
}
