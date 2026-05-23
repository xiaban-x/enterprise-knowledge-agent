/**
 * Document Store — Blob-based storage for summaries and documents.
 *
 * Storage layout (EdgeOne Pages Blob):
 *   rag-store/summary/{docId}.json → {docId, filename, summary, keywords, charCount, uploadedAt}
 *   rag-store/docs/{docId}.txt     → full document content
 *
 * No index.json needed — we use store.list({ prefix: "summary/" }) to enumerate all docs.
 * This eliminates race conditions from concurrent uploads.
 */
import { getStore } from "@edgeone/pages-blob";
import { createLogger } from "../agents/_shared";

const logger = createLogger("doc-store");

// ─── Types ───

export interface DocMeta {
  docId: string;
  filename: string;
  uploadedAt: string;
}

export interface DocSummary {
  docId: string;
  filename: string;
  summary: string;
  keywords: string[];
  charCount: number;
  uploadedAt?: string;
}

// ─── Blob Access ───

const BLOB_STORE_NAME = "rag-store";

function getBlobStore() {
  const projectId = process.env.PROJECT_ID;
  const token = process.env.EDGEONE_PAGES_API_TOKEN;
  if (projectId && token) {
    return getStore({ name: BLOB_STORE_NAME, projectId, token });
  }
  try {
    return getStore(BLOB_STORE_NAME);
  } catch {
    return null;
  }
}

// ─── List All Documents (via Blob list API) ───

/**
 * List all document IDs by listing keys with prefix "summary/".
 * No index.json needed — avoids race conditions entirely.
 */
export async function getIndex(): Promise<DocMeta[]> {
  const store = getBlobStore();
  if (!store) return [];

  try {
    const result = await store.list({ prefix: "summary/" });
    const metas: DocMeta[] = [];

    // Fetch each summary to get metadata
    for (const blob of result.blobs) {
      // Key format: "summary/{docId}.json"
      const docId = blob.key.replace("summary/", "").replace(".json", "");
      if (!docId) continue;

      try {
        const raw = await store.get(blob.key);
        if (raw) {
          const data = JSON.parse(raw) as DocSummary;
          metas.push({
            docId: data.docId || docId,
            filename: data.filename || docId,
            uploadedAt: data.uploadedAt || "",
          });
        }
      } catch {
        // Skip malformed entries
        metas.push({ docId, filename: docId, uploadedAt: "" });
      }
    }

    return metas;
  } catch (e) {
    logger.error("Failed to list documents:", (e as Error).message);
    return [];
  }
}

// ─── Summary Operations ───

export async function getSummary(docId: string): Promise<DocSummary | null> {
  const store = getBlobStore();
  if (!store) return null;
  try {
    const raw = await store.get(`summary/${docId}.json`);
    if (!raw) return null;
    return JSON.parse(raw) as DocSummary;
  } catch {
    return null;
  }
}

/**
 * Get all summaries — used by the router node to make routing decisions.
 * Lists all summary/ keys, then fetches each in parallel.
 * No index.json dependency = no race condition.
 */
export async function getAllSummaries(): Promise<DocSummary[]> {
  const store = getBlobStore();
  if (!store) return [];

  try {
    const result = await store.list({ prefix: "summary/" });
    if (result.blobs.length === 0) return [];

    const summaries = await Promise.all(
      result.blobs.map(async (blob) => {
        try {
          const raw = await store.get(blob.key);
          if (!raw) return null;
          return JSON.parse(raw) as DocSummary;
        } catch {
          return null;
        }
      })
    );

    return summaries.filter((s): s is DocSummary => s !== null);
  } catch (e) {
    logger.error("Failed to get all summaries:", (e as Error).message);
    return [];
  }
}

// ─── Document Content Operations ───

export async function getDocContent(docId: string): Promise<string | null> {
  const store = getBlobStore();
  if (!store) return null;
  try {
    const raw = await store.get(`docs/${docId}.txt`);
    return raw || null;
  } catch {
    return null;
  }
}

// ─── Save & Remove ───

export async function saveDoc(
  docId: string,
  filename: string,
  content: string,
  summary: string,
  keywords: string[]
): Promise<void> {
  const store = getBlobStore();
  if (!store) throw new Error("Blob store not available");

  // Save document content
  await store.set(`docs/${docId}.txt`, content);

  // Save summary (includes all metadata — no separate index needed)
  const summaryData: DocSummary = {
    docId,
    filename,
    summary,
    keywords,
    charCount: content.length,
    uploadedAt: new Date().toISOString(),
  };
  await store.set(`summary/${docId}.json`, JSON.stringify(summaryData));

  logger.log(`Saved doc: ${filename} (${docId}), ${content.length} chars`);
}

export async function removeDoc(docId: string): Promise<boolean> {
  const store = getBlobStore();
  if (!store) return false;

  try {
    // Remove content and summary — that's it, no index to update
    await store.delete(`docs/${docId}.txt`);
    await store.delete(`summary/${docId}.json`);

    logger.log(`Removed doc: ${docId}`);
    return true;
  } catch (e) {
    logger.error("Failed to remove doc:", (e as Error).message);
    return false;
  }
}
