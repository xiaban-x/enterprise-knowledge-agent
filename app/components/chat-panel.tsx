"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ docId: string; filename: string }>;
  routing?: { targetDocs: string[]; reason: string; totalDocs: number };
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationId = useMemo(() => `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);
    setCurrentStep("");

    let assistantContent = "";
    let sources: Message["sources"] = [];
    let routing: Message["routing"] = undefined;

    try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "pages-agent-conversation-id": conversationId,
        },
        body: JSON.stringify({ message: userMessage }),
      });

      if (!res.ok) {
        const err = await res.json();
        assistantContent = `Error: ${err.error}`;
        setMessages(prev => [...prev, { role: "assistant", content: assistantContent }]);
        setIsLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      // Add assistant message placeholder
      setMessages(prev => [...prev, { role: "assistant", content: "", sources: [], routing: undefined }]);

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
              case "node_start":
                setCurrentStep(event.node === "router" ? "Analyzing summaries..." : event.node === "load_docs" ? "Loading documents..." : "Generating answer...");
                break;

              case "routing":
                routing = {
                  targetDocs: event.targetDocs || [],
                  reason: event.reason || "",
                  totalDocs: event.totalDocs || 0,
                };
                setMessages(prev => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last.role === "assistant") last.routing = routing;
                  return copy;
                });
                break;

              case "docs_loaded":
                if (event.docs) {
                  sources = event.docs.map((filename: string) => ({ docId: "", filename }));
                }
                break;

              case "ai_response":
                if (event.content) {
                  assistantContent += event.content;
                  setMessages(prev => {
                    const copy = [...prev];
                    const last = copy[copy.length - 1];
                    if (last.role === "assistant") {
                      last.content = assistantContent;
                      last.sources = sources && sources.length > 0 ? [...sources] : undefined;
                    }
                    return copy;
                  });
                }
                break;
            }
          } catch {}
        }
      }

      // Final update
      setMessages(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last.role === "assistant") {
          last.sources = sources && sources.length > 0 ? sources : undefined;
          last.routing = routing;
        }
        return copy;
      });
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: `Network error: ${(e as Error).message}` }]);
    } finally {
      setIsLoading(false);
      setCurrentStep("");
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <h3 className="text-lg font-medium mb-2">Ask a question</h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Upload documents to the knowledge base, then ask questions. The AI will intelligently route to relevant documents on-demand — no vector database needed.
              </p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-2xl rounded-lg px-4 py-2 ${
              msg.role === "user"
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
            }`}>
              {/* Routing info */}
              {msg.routing && (
                <div className="mb-2 pb-2 border-b border-white/10 text-xs">
                  <div className="flex items-center gap-1 text-blue-400">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span>
                      Routed to {msg.routing.targetDocs.length} of {msg.routing.totalDocs} docs
                    </span>
                  </div>
                  {msg.routing.reason && (
                    <p className="text-[var(--text-secondary)] mt-0.5 ml-4">{msg.routing.reason}</p>
                  )}
                </div>
              )}

              {msg.content ? (
                <div className="text-sm prose prose-invert prose-sm max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
              ) : (
                isLoading && i === messages.length - 1 ? (
                  <p className="text-sm animate-pulse text-[var(--text-secondary)]">{currentStep || "..."}</p>
                ) : null
              )}

              {/* Sources */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-3 pt-2 border-t border-white/10">
                  <p className="text-xs text-[var(--text-secondary)] mb-1">Sources:</p>
                  {msg.sources.map((s, j) => (
                    <div key={j} className="text-xs bg-black/20 rounded px-2 py-1 mb-1 inline-block mr-1">
                      <span className="font-medium text-emerald-400">{s.filename}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="px-6 py-4 border-t border-[var(--border)]">
        <div className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask a question about your documents..."
            disabled={isLoading}
            className="flex-1 bg-[var(--bg-tertiary)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] border border-[var(--border)] rounded-lg px-4 py-2.5 outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-5 py-2.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
