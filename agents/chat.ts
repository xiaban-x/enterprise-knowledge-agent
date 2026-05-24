/**
 * RAG Chat Agent — LangGraph.js (Advanced On-Demand Retrieval)
 *
 * Demonstrates advanced LangGraph capabilities:
 *
 * 1. Conditional Edges — router decides between multiple paths:
 *    - no_docs: directly reply (no documents in KB)
 *    - not_relevant: ask user to clarify or suggest uploads
 *    - relevant: proceed to load docs
 *
 * 2. Cycles (Retry Loop) — after generating, self-evaluate quality:
 *    - quality OK → END
 *    - quality poor → retry with different docs (max 2 retries)
 *
 * 3. Parallel Loading — selected documents loaded concurrently
 *
 * 4. Tool Use Agent — LLM autonomously decides actions:
 *    - search_knowledge: query the document summaries
 *    - load_document: load a specific document
 *    - ask_clarification: request more info from user
 *    - direct_answer: answer without documents
 *
 * Graph topology:
 *
 *   START → agent_decide → [conditional]
 *                ├── "no_docs" → fallback_reply → END
 *                ├── "clarify" → ask_clarification → END
 *                └── "search"  → router → [conditional]
 *                                  ├── "not_relevant" → suggest_upload → END
 *                                  └── "relevant" → load_docs_parallel → generate_answer → evaluate
 *                                                                                            ├── "good" → END
 *                                                                                            └── "retry" → router (cycle, max 2x)
 */
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger, createModel, createSSEResponse, sseEvent } from "./_shared";
import { getAllSummaries, getDocContent, type DocSummary } from "../lib/doc-store";

const logger = createLogger("chat");

// ─── Graph State Schema ───

const GraphState = Annotation.Root({
  question: Annotation<string>(),
  // Conversation history for multi-turn context
  chatHistory: Annotation<Array<{ role: string; content: string }>>({
    reducer: (_, n) => n,
    default: () => [],
  }),
  // Agent decision
  action: Annotation<"search" | "clarify" | "no_docs" | "direct_answer">({
    reducer: (_, n) => n,
    default: () => "search" as const,
  }),
  clarifyMessage: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  // Router state
  summaries: Annotation<DocSummary[]>({ reducer: (_, n) => n, default: () => [] }),
  targetDocIds: Annotation<string[]>({ reducer: (_, n) => n, default: () => [] }),
  routingReason: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  // Document loading
  context: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  sources: Annotation<Array<{ docId: string; filename: string }>>({
    reducer: (_, n) => n,
    default: () => [],
  }),
  // Generation & evaluation
  answer: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  quality: Annotation<"good" | "poor" | "pending">({
    reducer: (_, n) => n,
    default: () => "pending" as const,
  }),
  retries: Annotation<number>({ reducer: (_, n) => n, default: () => 0 }),
  // Docs already tried (for retry with different docs)
  triedDocIds: Annotation<string[]>({ reducer: (_, n) => n, default: () => [] }),
});

// ─── Node: Agent Decision (Tool Use) ───
// LLM autonomously decides what action to take

async function agentDecide(state: typeof GraphState.State) {
  logger.log(`Agent deciding action for: "${state.question.slice(0, 60)}..."`);

  const summaries = await getAllSummaries();

  // No documents at all → no_docs path
  if (summaries.length === 0) {
    return { action: "no_docs" as const, summaries };
  }

  const model = createModel();

  const summaryList = summaries
    .map((s) => `- "${s.filename}": ${s.summary.slice(0, 100)}`)
    .join("\n");

  // Build conversation context for multi-turn understanding
  const historyText = state.chatHistory.length > 0
    ? `\n\nRecent conversation:\n${state.chatHistory.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const response = await model.invoke([
    new SystemMessage(`You are an intelligent assistant that decides the best action for a user question.
You have access to a knowledge base with ${summaries.length} documents:
${summaryList}
${historyText}

Based on the user's question (considering conversation context if any), decide ONE action:
1. "search" — The question can likely be answered by searching the documents above
2. "clarify" — The question is too vague or ambiguous to search effectively. You need more information.
3. "direct_answer" — The question is general knowledge unrelated to any document (e.g. "hello", "what's 2+2")

IMPORTANT: Consider the conversation history! If the user says something like "yes, that one" or "24" after a previous exchange, interpret it in context.

Output JSON only:
{"action": "search"|"clarify"|"direct_answer", "reason": "brief explanation"}
If action is "clarify", also include: "clarifyMessage": "your question to the user"`),
    new HumanMessage(state.question),
  ]);

  const text = typeof response.content === "string" ? response.content : "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const action = parsed.action || "search";
      logger.log(`Agent decided: ${action} — ${parsed.reason || ""}`);
      return {
        action: action as typeof state.action,
        summaries,
        clarifyMessage: parsed.clarifyMessage || "",
      };
    }
  } catch {}

  return { action: "search" as const, summaries };
}

// ─── Node: Fallback Reply (no documents) ───

async function fallbackReply(state: typeof GraphState.State) {
  const model = createModel();
  const response = await model.invoke([
    new SystemMessage(`The knowledge base is empty. Politely inform the user and suggest they upload documents. Use the same language as the question.`),
    new HumanMessage(state.question),
  ]);
  return { answer: typeof response.content === "string" ? response.content : "" };
}

// ─── Node: Ask Clarification ───

async function askClarification(state: typeof GraphState.State) {
  // Use the clarify message from agent decision, or generate one
  if (state.clarifyMessage) {
    return { answer: state.clarifyMessage };
  }
  const model = createModel();
  const response = await model.invoke([
    new SystemMessage(`The user's question is ambiguous. Ask a clarifying question to better understand what they need. Be concise and helpful. Use the same language as the question.`),
    new HumanMessage(state.question),
  ]);
  return { answer: typeof response.content === "string" ? response.content : "" };
}

// ─── Node: Direct Answer (no docs needed) ───

async function directAnswer(state: typeof GraphState.State) {
  const model = createModel();
  const response = await model.invoke([
    new SystemMessage(`Answer the user's question directly. This is general conversation, not a document query. Be concise and friendly. Use the same language as the question.`),
    new HumanMessage(state.question),
  ]);
  return { answer: typeof response.content === "string" ? response.content : "" };
}

// ─── Node: Router ───
// Reads summaries, decides which docs to load

async function router(state: typeof GraphState.State) {
  logger.log(`Routing for: "${state.question.slice(0, 60)}..." (retry #${state.retries})`);

  const summaries = state.summaries;
  if (summaries.length === 0) {
    return { targetDocIds: [], routingReason: "No documents available" };
  }

  // Filter out already-tried docs on retry
  const availableSummaries = state.retries > 0
    ? summaries.filter((s) => !state.triedDocIds.includes(s.docId))
    : summaries;

  if (availableSummaries.length === 0) {
    return { targetDocIds: [], routingReason: "All documents already tried" };
  }

  const summaryText = availableSummaries
    .map((s, i) => `[${i + 1}] DocID: ${s.docId}\n    File: ${s.filename}\n    Summary: ${s.summary}\n    Keywords: ${s.keywords.join(", ")}`)
    .join("\n\n");

  const model = createModel();
  const retryHint = state.retries > 0
    ? `\nNote: Previous documents didn't provide a good answer. Try selecting DIFFERENT documents this time.`
    : "";

  const historyContext = state.chatHistory.length > 0
    ? `\n\nConversation context:\n${state.chatHistory.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const response = await model.invoke([
    new SystemMessage(`You are a document routing assistant. Given a user question and document summaries, select 1-2 documents most likely to contain the answer.${retryHint}
${historyContext ? "\nIMPORTANT: Consider the conversation history to understand the user's intent. Resolve pronouns and references." : ""}

Output JSON only:
{"docIds": ["id1", "id2"], "reason": "why these docs"}
If NO document is relevant: {"docIds": [], "reason": "explanation"}`),
    new HumanMessage(`Question: ${state.question}${historyContext}\n\nAvailable documents:\n${summaryText}`),
  ]);

  const text = typeof response.content === "string" ? response.content : "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const docIds = Array.isArray(parsed.docIds) ? parsed.docIds : [];
      logger.log(`Router selected ${docIds.length} docs: ${parsed.reason || ""}`);
      return { targetDocIds: docIds, routingReason: parsed.reason || "" };
    }
  } catch {}

  return { targetDocIds: [], routingReason: "Failed to parse routing decision" };
}

// ─── Node: Load Docs Parallel ───
// Loads selected documents concurrently using Promise.all

async function loadDocsParallel(state: typeof GraphState.State) {
  if (state.targetDocIds.length === 0) {
    return { context: "", sources: [] };
  }

  logger.log(`Loading ${state.targetDocIds.length} docs in parallel...`);

  // Parallel loading — all selected docs fetched concurrently
  const results = await Promise.all(
    state.targetDocIds.map(async (docId) => {
      const content = await getDocContent(docId);
      const summary = state.summaries.find((s) => s.docId === docId);
      return { docId, filename: summary?.filename || docId, content };
    })
  );

  const loaded = results.filter((r) => r.content !== null);
  const context = loaded
    .map((d, i) => `━━━ Document ${i + 1}: ${d.filename} ━━━\n${d.content}`)
    .join("\n\n");

  const sources = loaded.map((d) => ({ docId: d.docId, filename: d.filename }));

  // Track tried docs for retry
  const triedDocIds = [...state.triedDocIds, ...state.targetDocIds];

  logger.log(`Loaded ${loaded.length} docs in parallel, total ${context.length} chars`);
  return { context, sources, triedDocIds };
}

// ─── Node: Generate Answer ───

async function generateAnswer(state: typeof GraphState.State) {
  const model = createModel();

  if (!state.context) {
    return {
      answer: "I couldn't find relevant content in the loaded documents. Please try rephrasing your question or upload more relevant documents.",
    };
  }

  const historyContext = state.chatHistory.length > 0
    ? `\n\nConversation history:\n${state.chatHistory.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const response = await model.invoke([
    new SystemMessage(`You are a knowledgeable assistant. Answer the question based on the provided document content.
Rules:
- Cite sources by referencing [Source: filename]
- If the documents don't fully answer the question, say what you can determine and note what's missing
- Be concise but thorough
- Use the same language as the question
- Consider conversation history to understand context and follow-up questions`),
    new HumanMessage(`Question: ${state.question}${historyContext}\n\nDocument content:\n${state.context}`),
  ]);

  const answer = typeof response.content === "string" ? response.content : "";
  return { answer };
}

// ─── Node: Evaluate Quality (Self-Reflection) ───
// Evaluates whether the answer is good enough, or needs retry

async function evaluate(state: typeof GraphState.State) {
  // Max retries reached → accept whatever we have
  if (state.retries >= 2) {
    logger.log("Max retries reached, accepting answer");
    return { quality: "good" as const };
  }

  // No answer → poor
  if (!state.answer || state.answer.length < 20) {
    return { quality: "poor" as const, retries: state.retries + 1 };
  }

  const model = createModel();
  const response = await model.invoke([
    new SystemMessage(`You are a quality evaluator. Given a question and an AI-generated answer, judge if the answer adequately addresses the question.

Criteria for "good":
- Actually answers the question (not just tangential info)
- Cites sources from documents
- Is substantive (not just "I don't know")

Output JSON only: {"quality": "good"|"poor", "reason": "brief explanation"}`),
    new HumanMessage(`Question: ${state.question}\n\nAnswer: ${state.answer}`),
  ]);

  const text = typeof response.content === "string" ? response.content : "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const quality = parsed.quality === "poor" ? "poor" : "good";
      logger.log(`Quality evaluation: ${quality} — ${parsed.reason || ""}`);
      return {
        quality: quality as "good" | "poor",
        retries: quality === "poor" ? state.retries + 1 : state.retries,
      };
    }
  } catch {}

  return { quality: "good" as const };
}

// ─── Node: Suggest Upload ───

async function suggestUpload(state: typeof GraphState.State) {
  const model = createModel();
  const response = await model.invoke([
    new SystemMessage(`The user asked a question but no relevant documents were found in the knowledge base. Suggest what kind of documents they should upload to get an answer. Be specific and helpful. Use the same language as the question.`),
    new HumanMessage(`Question: ${state.question}\n\nAvailable documents (not relevant): ${state.summaries.map((s) => s.filename).join(", ")}`),
  ]);
  return { answer: typeof response.content === "string" ? response.content : "" };
}

// ─── Conditional Edges ───

function afterAgentDecide(state: typeof GraphState.State): "no_docs" | "clarify" | "direct_answer" | "search" {
  return state.action;
}

function afterRouter(state: typeof GraphState.State): "relevant" | "not_relevant" {
  return state.targetDocIds.length > 0 ? "relevant" : "not_relevant";
}

function afterEvaluate(state: typeof GraphState.State): "good" | "retry" {
  if (state.quality === "poor" && state.retries <= 2) return "retry";
  return "good";
}

// ─── Build Graph ───

function buildGraph() {
  const graph = new StateGraph(GraphState)
    // Nodes
    .addNode("agent_decide", agentDecide)
    .addNode("fallback_reply", fallbackReply)
    .addNode("ask_clarification", askClarification)
    .addNode("direct_answer", directAnswer)
    .addNode("router", router)
    .addNode("suggest_upload", suggestUpload)
    .addNode("load_docs_parallel", loadDocsParallel)
    .addNode("generate_answer", generateAnswer)
    .addNode("evaluate", evaluate)
    // Edges
    .addEdge(START, "agent_decide")
    // Conditional: agent decides action
    .addConditionalEdges("agent_decide", afterAgentDecide, {
      no_docs: "fallback_reply",
      clarify: "ask_clarification",
      direct_answer: "direct_answer",
      search: "router",
    })
    // Terminal nodes
    .addEdge("fallback_reply", END)
    .addEdge("ask_clarification", END)
    .addEdge("direct_answer", END)
    // Conditional: router found relevant docs?
    .addConditionalEdges("router", afterRouter, {
      relevant: "load_docs_parallel",
      not_relevant: "suggest_upload",
    })
    .addEdge("suggest_upload", END)
    // Main pipeline
    .addEdge("load_docs_parallel", "generate_answer")
    .addEdge("generate_answer", "evaluate")
    // Conditional: quality good enough?
    .addConditionalEdges("evaluate", afterEvaluate, {
      good: END,
      retry: "router",  // CYCLE: go back to router with different docs
    });

  return graph.compile();
}

// ─── Stream Generator ───

async function* streamRAG(
  userMessage: string,
  chatHistory: Array<{ role: string; content: string }>,
  context: any,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const app = buildGraph();

  yield sseEvent({ type: "status", status: "processing" });

  const stream = await app.stream(
    { question: userMessage, chatHistory },
    { signal }
  );

  let finalAnswer = "";
  let finalSources: any[] = [];

  for await (const event of stream) {
    if (signal?.aborted) break;

    for (const [nodeName, output] of Object.entries(event)) {
      const nodeOutput = output as any;

      switch (nodeName) {
        case "agent_decide":
          yield sseEvent({ type: "node_start", node: "agent_decide" });
          yield sseEvent({
            type: "agent_action",
            action: nodeOutput.action,
            totalDocs: nodeOutput.summaries?.length || 0,
          });
          yield sseEvent({ type: "node_complete", node: "agent_decide" });
          break;

        case "router":
          yield sseEvent({ type: "node_start", node: "router" });
          yield sseEvent({
            type: "routing",
            targetDocs: nodeOutput.targetDocIds || [],
            reason: nodeOutput.routingReason || "",
          });
          yield sseEvent({ type: "node_complete", node: "router" });
          break;

        case "load_docs_parallel":
          yield sseEvent({ type: "node_start", node: "load_docs_parallel" });
          if (nodeOutput.sources) {
            finalSources = nodeOutput.sources;
            yield sseEvent({
              type: "docs_loaded",
              docs: nodeOutput.sources.map((s: any) => s.filename),
              chars: nodeOutput.context?.length || 0,
              parallel: true,
            });
          }
          yield sseEvent({ type: "node_complete", node: "load_docs_parallel" });
          break;

        case "generate_answer":
          yield sseEvent({ type: "node_start", node: "generate_answer" });
          if (nodeOutput.answer) {
            finalAnswer = nodeOutput.answer;
            yield sseEvent({ type: "ai_response", content: nodeOutput.answer });
          }
          yield sseEvent({ type: "node_complete", node: "generate_answer" });
          break;

        case "evaluate":
          yield sseEvent({ type: "node_start", node: "evaluate" });
          yield sseEvent({
            type: "quality_eval",
            quality: nodeOutput.quality,
            retries: nodeOutput.retries,
          });
          yield sseEvent({ type: "node_complete", node: "evaluate" });
          break;

        case "fallback_reply":
        case "ask_clarification":
        case "direct_answer":
        case "suggest_upload":
          yield sseEvent({ type: "node_start", node: nodeName });
          if (nodeOutput.answer) {
            finalAnswer = nodeOutput.answer;
            yield sseEvent({ type: "ai_response", content: nodeOutput.answer });
          }
          yield sseEvent({ type: "node_complete", node: nodeName });
          break;
      }
    }
  }

  // Save to memory
  try {
    if (context.store) {
      const conversationId = context.conversation_id || "default";
      await context.store.appendMessage({ conversationId, role: "user", content: userMessage });
      if (finalAnswer) {
        await context.store.appendMessage({ conversationId, role: "assistant", content: finalAnswer });
      }
    }
  } catch {}

  yield sseEvent({ type: "status", status: "complete", sources: finalSources });
  yield "data: [DONE]\n\n";
}

// ─── HTTP Handler ───

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { message, history } = body;

  if (!message) {
    return new Response(JSON.stringify({ error: "Missing message" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const chatHistory = Array.isArray(history) ? history : [];
  const signal = request?.signal as AbortSignal | undefined;
  const generator = streamRAG(message, chatHistory, context, signal);
  return createSSEResponse(generator, signal);
}
