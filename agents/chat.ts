/**
 * RAG Chat Agent — LangGraph.js (On-Demand Retrieval)
 *
 * Uses a StateGraph to implement summary-based routing:
 *
 *   router → load_docs → generate_answer
 *
 * Key concept: "On-demand retrieval"
 * - Router reads lightweight summaries to decide which docs are relevant
 * - Only selected documents are loaded (zero token cost for unselected ones)
 * - No vector database, no embeddings — pure LLM routing
 *
 * LangGraph features demonstrated:
 * - StateGraph with typed Annotation
 * - Sequential pipeline with routing logic
 * - Streaming node outputs as SSE events
 */
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger, createModel, createSSEResponse, sseEvent } from "./_shared";
import { getAllSummaries, getDocContent, type DocSummary } from "../lib/doc-store";

const logger = createLogger("chat");

// ─── Graph State Schema ───

const GraphState = Annotation.Root({
  question: Annotation<string>(),
  summaries: Annotation<DocSummary[]>({ reducer: (_, n) => n, default: () => [] }),
  targetDocIds: Annotation<string[]>({ reducer: (_, n) => n, default: () => [] }),
  routingReason: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  context: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  answer: Annotation<string>({ reducer: (_, n) => n, default: () => "" }),
  sources: Annotation<Array<{ docId: string; filename: string }>>({ reducer: (_, n) => n, default: () => [] }),
});

// ─── Graph Nodes ───

/**
 * Node 1: Router — reads all summaries, decides which 1-2 docs are relevant.
 * This is the "on-demand" core: only summaries are read (very lightweight),
 * and the LLM decides where to look based on the question.
 */
async function router(state: typeof GraphState.State) {
  logger.log(`Routing for: "${state.question.slice(0, 60)}..."`);

  const summaries = await getAllSummaries();
  if (summaries.length === 0) {
    return {
      summaries,
      targetDocIds: [],
      routingReason: "No documents in knowledge base",
    };
  }

  // Build summary list for LLM
  const summaryText = summaries
    .map((s, i) => `[${i + 1}] DocID: ${s.docId}\n    Filename: ${s.filename}\n    Summary: ${s.summary}\n    Keywords: ${s.keywords.join(", ")}`)
    .join("\n\n");

  const model = createModel();
  const response = await model.invoke([
    new SystemMessage(`You are a document routing assistant. Given a user question and a list of document summaries, determine which 1-2 documents are most likely to contain the answer.

Output in this exact JSON format (no other text):
{"docIds": ["docId1", "docId2"], "reason": "brief explanation of why these docs were selected"}

If NO document seems relevant, output:
{"docIds": [], "reason": "No relevant documents found for this question"}`),
    new HumanMessage(`Question: ${state.question}\n\nAvailable documents:\n${summaryText}`),
  ]);

  const text = typeof response.content === "string" ? response.content : "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const docIds = Array.isArray(parsed.docIds) ? parsed.docIds : [];
      const reason = parsed.reason || "";
      logger.log(`Router decision: ${docIds.length} docs selected — ${reason}`);
      return { summaries, targetDocIds: docIds, routingReason: reason };
    }
  } catch {}

  return { summaries, targetDocIds: [], routingReason: "Failed to parse routing decision" };
}

/**
 * Node 2: Load Documents — fetch full content of selected documents only.
 * Unselected documents consume zero tokens.
 */
async function loadDocs(state: typeof GraphState.State) {
  if (state.targetDocIds.length === 0) {
    return { context: "", sources: [] };
  }

  const docs: Array<{ docId: string; filename: string; content: string }> = [];

  for (const docId of state.targetDocIds) {
    const content = await getDocContent(docId);
    if (content) {
      const summary = state.summaries.find((s) => s.docId === docId);
      docs.push({
        docId,
        filename: summary?.filename || docId,
        content,
      });
    }
  }

  const context = docs
    .map((d, i) => `━━━ Document ${i + 1}: ${d.filename} ━━━\n${d.content}`)
    .join("\n\n");

  const sources = docs.map((d) => ({ docId: d.docId, filename: d.filename }));

  logger.log(`Loaded ${docs.length} docs, total ${context.length} chars`);
  return { context, sources };
}

/**
 * Node 3: Generate Answer — produce final answer based on loaded documents.
 */
async function generateAnswer(state: typeof GraphState.State) {
  const model = createModel();

  if (!state.context) {
    const response = await model.invoke([
      new SystemMessage(`You are a helpful assistant. The user asked a question but no relevant documents were found in the knowledge base. Let them know politely and suggest what kind of documents they might upload. Use the same language as the question.`),
      new HumanMessage(state.question),
    ]);
    const answer = typeof response.content === "string" ? response.content : "";
    return { answer };
  }

  const response = await model.invoke([
    new SystemMessage(`You are a knowledgeable assistant. Answer the question based on the provided document content.
Rules:
- Cite sources by referencing [Source: filename]
- If the documents don't fully answer the question, say what you can determine and note what's missing
- Be concise but thorough
- Use the same language as the question`),
    new HumanMessage(`Question: ${state.question}\n\nDocument content:\n${state.context}`),
  ]);

  const answer = typeof response.content === "string" ? response.content : "";
  return { answer };
}

// ─── Build Graph ───

function buildGraph() {
  const graph = new StateGraph(GraphState)
    .addNode("router", router)
    .addNode("load_docs", loadDocs)
    .addNode("generate_answer", generateAnswer)
    .addEdge(START, "router")
    .addEdge("router", "load_docs")
    .addEdge("load_docs", "generate_answer")
    .addEdge("generate_answer", END);

  return graph.compile();
}

// ─── Stream Generator ───

async function* streamRAG(
  userMessage: string,
  context: any,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const app = buildGraph();

  yield sseEvent({ type: "status", status: "processing" });

  const stream = await app.stream(
    { question: userMessage },
    { signal }
  );

  let finalAnswer = "";
  let finalSources: any[] = [];

  for await (const event of stream) {
    if (signal?.aborted) break;

    for (const [nodeName, output] of Object.entries(event)) {
      const nodeOutput = output as any;

      switch (nodeName) {
        case "router":
          yield sseEvent({ type: "node_start", node: "router" });
          yield sseEvent({
            type: "routing",
            targetDocs: nodeOutput.targetDocIds || [],
            reason: nodeOutput.routingReason || "",
            totalDocs: nodeOutput.summaries?.length || 0,
          });
          yield sseEvent({ type: "node_complete", node: "router" });
          break;

        case "load_docs":
          yield sseEvent({ type: "node_start", node: "load_docs" });
          if (nodeOutput.sources) {
            finalSources = nodeOutput.sources;
            yield sseEvent({
              type: "docs_loaded",
              docs: nodeOutput.sources.map((s: any) => s.filename),
              chars: nodeOutput.context?.length || 0,
            });
          }
          yield sseEvent({ type: "node_complete", node: "load_docs" });
          break;

        case "generate_answer":
          yield sseEvent({ type: "node_start", node: "generate_answer" });
          if (nodeOutput.answer) {
            finalAnswer = nodeOutput.answer;
            yield sseEvent({ type: "ai_response", content: nodeOutput.answer });
          }
          yield sseEvent({ type: "node_complete", node: "generate_answer" });
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
  const { message } = body;

  if (!message) {
    return new Response(JSON.stringify({ error: "Missing message" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const signal = request?.signal as AbortSignal | undefined;
  const generator = streamRAG(message, context, signal);
  return createSSEResponse(generator, signal);
}
