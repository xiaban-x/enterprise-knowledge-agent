"use client";

import { useState, useRef, useEffect, useMemo, KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface TraceStep {
  node: string;
  label: string;
  detail?: string;
  timestamp: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{ docId: string; filename: string }>;
  routing?: { targetDocs: string[]; reason: string; totalDocs: number };
  agentAction?: string;
  quality?: { quality: string; retries: number };
  trace?: TraceStep[];
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  const isComposingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const conversationId = useMemo(() => `rag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const stepLabels: Record<string, string> = {
    agent_decide: "Deciding action...",
    router: "Analyzing summaries...",
    load_docs_parallel: "Loading documents (parallel)...",
    generate_answer: "Generating answer...",
    evaluate: "Evaluating quality...",
    fallback_reply: "Generating response...",
    ask_clarification: "Preparing clarification...",
    direct_answer: "Answering directly...",
    suggest_upload: "Suggesting documents...",
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);
    setCurrentStep("Thinking...");

    let assistantContent = "";
    let sources: Message["sources"] = [];
    let routing: Message["routing"] = undefined;
    let agentAction = "";
    let quality: Message["quality"] = undefined;
    let trace: TraceStep[] = [];

    // Immediately show assistant placeholder with loading state
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

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
        setMessages(prev => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last.role === "assistant") last.content = assistantContent;
          return copy;
        });
        setIsLoading(false);
        return;
      }

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
              case "node_start":
                setCurrentStep(stepLabels[event.node] || `Running ${event.node}...`);
                break;

              case "agent_action":
                agentAction = event.action;
                trace.push({
                  node: "agent_decide",
                  label: "Agent Decision (Tool Use)",
                  detail: `Action: ${event.action}${event.totalDocs > 0 ? ` | ${event.totalDocs} docs in KB` : ""}`,
                  timestamp: Date.now(),
                });
                setMessages(prev => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last.role === "assistant") { last.agentAction = event.action; last.trace = [...trace]; }
                  return copy;
                });
                break;

              case "routing":
                routing = {
                  targetDocs: event.targetDocs || [],
                  reason: event.reason || "",
                  totalDocs: event.totalDocs || 0,
                };
                trace.push({
                  node: "router",
                  label: "Summary Routing",
                  detail: event.targetDocs?.length > 0
                    ? `Read all summaries → Selected: ${event.targetDocs.join(", ")} | Reason: ${event.reason}`
                    : `Read all summaries → No relevant docs found`,
                  timestamp: Date.now(),
                });
                setMessages(prev => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last.role === "assistant") { last.routing = routing; last.trace = [...trace]; }
                  return copy;
                });
                break;

              case "docs_loaded":
                if (event.docs) {
                  sources = event.docs.map((filename: string) => ({ docId: "", filename }));
                  trace.push({
                    node: "load_docs_parallel",
                    label: "On-Demand Document Loading",
                    detail: `Loaded ${event.docs.length} doc(s) in parallel: ${event.docs.join(", ")} (${((event.chars || 0) / 1000).toFixed(1)}k chars)`,
                    timestamp: Date.now(),
                  });
                  setMessages(prev => {
                    const copy = [...prev];
                    const last = copy[copy.length - 1];
                    if (last.role === "assistant") last.trace = [...trace];
                    return copy;
                  });
                }
                break;

              case "quality_eval":
                quality = { quality: event.quality, retries: event.retries };
                trace.push({
                  node: "evaluate",
                  label: "Self-Evaluation",
                  detail: event.quality === "good"
                    ? "Answer quality: Good ✓"
                    : `Answer quality: Poor → Retrying with different docs (attempt ${event.retries})`,
                  timestamp: Date.now(),
                });
                setMessages(prev => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last.role === "assistant") { last.quality = quality; last.trace = [...trace]; }
                  return copy;
                });
                break;

              case "ai_response":
                if (event.content) {
                  assistantContent = event.content;
                  trace.push({
                    node: "generate_answer",
                    label: "Generate Answer",
                    detail: `Generated ${event.content.length} chars based on loaded documents`,
                    timestamp: Date.now(),
                  });
                  setMessages(prev => {
                    const copy = [...prev];
                    const last = copy[copy.length - 1];
                    if (last.role === "assistant") {
                      last.content = assistantContent;
                      last.sources = sources && sources.length > 0 ? [...sources] : undefined;
                      last.trace = [...trace];
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
          last.agentAction = agentAction;
          last.quality = quality;
          last.trace = trace.length > 0 ? [...trace] : undefined;
        }
        return copy;
      });
    } catch (e) {
      setMessages(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last.role === "assistant") last.content = `Network error: ${(e as Error).message}`;
        return copy;
      });
    } finally {
      setIsLoading(false);
      setCurrentStep("");
    }
  }

  const [expandedTraces, setExpandedTraces] = useState<Set<number>>(new Set());

  const actionLabels: Record<string, string> = {
    search: "Document Search",
    clarify: "Asking Clarification",
    direct_answer: "Direct Answer",
    no_docs: "No Documents",
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <h3 className="text-lg font-medium mb-2">Ask a question</h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Upload documents to the knowledge base, then ask questions. The AI Agent will intelligently route to relevant documents on-demand.
              </p>
              <div className="mt-4 text-xs text-[var(--text-secondary)] opacity-60 space-y-1">
                <p>Powered by LangGraph: Conditional routing, parallel loading, self-evaluation with retry</p>
              </div>
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
              {/* Execution Trace — shows the full agent decision pipeline */}
              {msg.trace && msg.trace.length > 0 && (
                <div className="mb-2">
                  <button
                    onClick={() => {
                      setExpandedTraces(prev => {
                        const next = new Set(prev);
                        next.has(i) ? next.delete(i) : next.add(i);
                        return next;
                      });
                    }}
                    className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  >
                    <svg className={`w-3 h-3 transition-transform ${expandedTraces.has(i) ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="font-medium">Agent Trace</span>
                    <span className="opacity-60">({msg.trace.length} steps)</span>
                  </button>

                  {expandedTraces.has(i) && (
                    <div className="mt-2 ml-1 border-l-2 border-blue-500/30 pl-3 space-y-2">
                      {msg.trace.map((step, j) => (
                        <div key={j} className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full shrink-0 ${
                              step.node === "agent_decide" ? "bg-purple-400" :
                              step.node === "router" ? "bg-blue-400" :
                              step.node === "load_docs_parallel" ? "bg-emerald-400" :
                              step.node === "generate_answer" ? "bg-cyan-400" :
                              step.node === "evaluate" ? "bg-amber-400" :
                              "bg-gray-400"
                            }`} />
                            <span className="font-medium text-[var(--text-primary)]">{step.label}</span>
                          </div>
                          {step.detail && (
                            <p className="text-[var(--text-secondary)] ml-3.5 mt-0.5">{step.detail}</p>
                          )}
                        </div>
                      ))}
                    </div>
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
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => { isComposingRef.current = false; }}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current) {
                e.preventDefault();
                handleSubmit(e as any);
              }
            }}
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
