/**
 * Knowledge Base Management Agent
 *
 * List documents, get stats, delete documents.
 */
import { createLogger } from "./_shared";
import { getIndex, getAllSummaries, removeDoc } from "../lib/doc-store";

const logger = createLogger("manage");

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { action = "list", documentId } = body;

  try {
    switch (action) {
      case "list": {
        const index = await getIndex();
        const summaries = await getAllSummaries();

        const documents = index.map((meta) => {
          const summary = summaries.find((s) => s.docId === meta.docId);
          return {
            docId: meta.docId,
            filename: meta.filename,
            uploadedAt: meta.uploadedAt,
            summary: summary?.summary || "",
            keywords: summary?.keywords || [],
            charCount: summary?.charCount || 0,
          };
        });

        return new Response(JSON.stringify({ documents, total: documents.length }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      case "delete": {
        if (!documentId) {
          return new Response(JSON.stringify({ error: "Missing documentId" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const removed = await removeDoc(documentId);
        return new Response(JSON.stringify({ success: removed, documentId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
    }
  } catch (e) {
    logger.error("Manage error:", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
