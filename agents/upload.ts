/**
 * Document Upload Agent
 *
 * Handles document upload: parses various formats (PDF, DOCX, XLSX, PPTX, etc.),
 * generates summary via AI Gateway, stores content and summary in Blob.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLogger, createModel } from "./_shared";
import { saveDoc } from "../lib/doc-store";
import { parseDocument } from "../lib/parser";

const logger = createLogger("upload");

/**
 * Generate a summary and keywords for a document using AI Gateway.
 */
async function generateSummary(
  content: string,
  filename: string
): Promise<{ summary: string; keywords: string[] }> {
  const model = createModel();

  // Truncate content if too long for summarization (keep first 8000 chars)
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
    // Try to parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || text.slice(0, 400),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      };
    }
  } catch {}

  // Fallback: use the raw response as summary
  return {
    summary: text.slice(0, 400),
    keywords: [],
  };
}

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { content, filename, documentId, isBinary } = body;

  if (!content || !filename) {
    return new Response(JSON.stringify({ error: "Missing content or filename" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const docId = documentId || `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    logger.log(`Processing document: ${filename} (${content.length} chars, binary: ${!!isBinary})`);

    // Parse document to extract text
    const text = await parseDocument(isBinary ? Buffer.from(content, "base64") : content, filename);
    if (!text || text.trim().length < 10) {
      return new Response(JSON.stringify({ error: "Could not extract meaningful text from document" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    logger.log(`Extracted ${text.length} chars from ${filename}`);

    // Generate summary using AI Gateway
    logger.log("Generating summary...");
    const { summary, keywords } = await generateSummary(text, filename);
    logger.log(`Summary generated: ${summary.slice(0, 80)}... | Keywords: ${keywords.join(", ")}`);

    // Save to Blob store (store extracted text, not raw binary)
    await saveDoc(docId, filename, text, summary, keywords);

    return new Response(JSON.stringify({
      success: true,
      documentId: docId,
      filename,
      summary,
      keywords,
      characters: text.length,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    logger.error("Upload error:", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
