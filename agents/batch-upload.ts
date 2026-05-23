/**
 * Batch Upload Agent
 *
 * Accepts an array of documents and processes them sequentially,
 * generating summaries for each via AI Gateway.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger, createModel, createSSEResponse, sseEvent } from "./_shared";
import { saveDoc } from "../lib/doc-store";
import { parseDocument } from "../lib/parser";

const logger = createLogger("batch-upload");

async function generateSummary(
  content: string,
  filename: string
): Promise<{ summary: string; keywords: string[] }> {
  const model = createModel();
  const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n...[truncated]" : content;

  const response = await model.invoke([
    new SystemMessage(`You are a document summarization assistant. Given a document, produce:
1. A concise summary (200 words max) covering the core topics, key points, and purpose of the document.
2. A list of 5-10 keywords that capture the main subjects.

Output in this exact JSON format (no other text):
{"summary": "...", "keywords": ["keyword1", "keyword2", ...]}`),
    new HumanMessage(`Filename: ${filename}\n\nDocument content:\n${truncated}`),
  ]);

  const text = typeof response.content === "string" ? response.content : "";

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || text.slice(0, 400),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      };
    }
  } catch {}

  return { summary: text.slice(0, 400), keywords: [] };
}

async function* streamBatchUpload(
  files: Array<{ content: string; filename: string; documentId?: string; isBinary?: boolean }>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  yield sseEvent({ type: "batch_start", total: files.length });

  const results: Array<{ filename: string; docId: string; success: boolean; error?: string }> = [];

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break;

    const file = files[i];
    const docId = file.documentId || `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    yield sseEvent({ type: "file_start", index: i, filename: file.filename, total: files.length });

    try {
      // Parse document
      const text = await parseDocument(
        file.isBinary ? Buffer.from(file.content, "base64") : file.content,
        file.filename
      );
      if (!text || text.trim().length < 10) {
        throw new Error("Could not extract meaningful text");
      }

      const { summary, keywords } = await generateSummary(text, file.filename);
      await saveDoc(docId, file.filename, text, summary, keywords);

      results.push({ filename: file.filename, docId, success: true });
      yield sseEvent({
        type: "file_complete",
        index: i,
        filename: file.filename,
        docId,
        summary: summary.slice(0, 100),
        keywords,
        characters: text.length,
      });
    } catch (e) {
      const error = (e as Error).message;
      results.push({ filename: file.filename, docId, success: false, error });
      yield sseEvent({ type: "file_error", index: i, filename: file.filename, error });
      logger.error(`Failed to process ${file.filename}:`, error);
    }
  }

  yield sseEvent({
    type: "batch_complete",
    total: files.length,
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
  yield "data: [DONE]\n\n";
}

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { files } = body;

  if (!Array.isArray(files) || files.length === 0) {
    return new Response(JSON.stringify({ error: "Missing or empty files array. Expected: [{content, filename}]" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate each file
  for (const file of files) {
    if (!file.content || !file.filename) {
      return new Response(JSON.stringify({ error: `Each file must have content and filename. Invalid: ${file.filename || "unknown"}` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const signal = request?.signal as AbortSignal | undefined;
  const generator = streamBatchUpload(files, signal);
  return createSSEResponse(generator, signal);
}
