/**
 * CLI Batch Import Script
 *
 * Reads all supported files from a directory, generates summaries via AI Gateway,
 * and saves them to EdgeOne Pages Blob.
 *
 * Usage:
 *   npx tsx scripts/import.ts ./docs
 *
 * Environment variables required:
 *   AI_GATEWAY_BASE_URL - Pages AI Gateway URL
 *   AI_GATEWAY_API_KEY  - Pages AI Gateway key
 *   PROJECT_ID          - EdgeOne Pages project ID
 *   EDGEONE_PAGES_API_TOKEN - Pages API token for Blob access
 *   AI_MODEL            - (optional) defaults to @Pages/deepseek-v4-flash
 */
import * as fs from "fs";
import * as path from "path";

// Supported file extensions
const SUPPORTED_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".ts", ".js", ".py", ".go", ".rs", ".java",
  ".tex", ".yaml", ".yml", ".xml", ".html", ".css", ".sql",
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
]);

const BINARY_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"]);

// ─── AI Gateway Summary Generation ───

async function generateSummary(
  content: string,
  filename: string
): Promise<{ summary: string; keywords: string[] }> {
  const baseUrl = process.env.AI_GATEWAY_BASE_URL;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  const model = process.env.AI_MODEL || "@Pages/deepseek-v4-flash";

  if (!baseUrl || !apiKey) {
    throw new Error("AI_GATEWAY_BASE_URL and AI_GATEWAY_API_KEY are required");
  }

  const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n...[truncated]" : content;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `You are a document summarization assistant. Given a document, produce:
1. A concise summary (200 words max) covering the core topics, key points, and purpose of the document.
2. A list of 5-10 keywords that capture the main subjects.

Output in this exact JSON format (no other text):
{"summary": "...", "keywords": ["keyword1", "keyword2", ...]}`,
        },
        {
          role: "user",
          content: `Filename: ${filename}\n\nDocument content:\n${truncated}`,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI Gateway error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";

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

// ─── Blob Storage (direct API calls) ───

async function blobSet(key: string, value: string): Promise<void> {
  const projectId = process.env.PROJECT_ID;
  const token = process.env.EDGEONE_PAGES_API_TOKEN;

  if (!projectId || !token) {
    throw new Error("PROJECT_ID and EDGEONE_PAGES_API_TOKEN are required");
  }

  // Use @edgeone/pages-blob compatible API
  const { getStore } = await import("@edgeone/pages-blob");
  const store = getStore({ name: "rag-store", projectId, token });
  await store.set(key, value);
}

async function blobGet(key: string): Promise<string | null> {
  const projectId = process.env.PROJECT_ID;
  const token = process.env.EDGEONE_PAGES_API_TOKEN;

  if (!projectId || !token) return null;

  const { getStore } = await import("@edgeone/pages-blob");
  const store = getStore({ name: "rag-store", projectId, token });
  return await store.get(key);
}

// ─── Main Import Logic ───

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: npx tsx scripts/import.ts <directory>");
    console.error("Example: npx tsx scripts/import.ts ./docs");
    process.exit(1);
  }

  const dirPath = path.resolve(args[0]);

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    console.error(`Error: ${dirPath} is not a valid directory`);
    process.exit(1);
  }

  // Check required env vars
  const required = ["AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY", "PROJECT_ID", "EDGEONE_PAGES_API_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    console.error("Set them in .env or export them before running this script.");
    process.exit(1);
  }

  // Find all supported files
  const files = fs.readdirSync(dirPath).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  });

  if (files.length === 0) {
    console.error(`No supported files found in ${dirPath}`);
    console.error(`Supported: ${Array.from(SUPPORTED_EXTENSIONS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n📂 Found ${files.length} files in ${dirPath}\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filePath = path.join(dirPath, filename);
    const ext = path.extname(filename).toLowerCase();
    const isBinary = BINARY_EXTENSIONS.has(ext);

    let content: string;
    let textContent: string;
    const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (isBinary) {
      const buffer = fs.readFileSync(filePath);
      content = buffer.toString("base64");
      // Parse binary to get text for summary
      try {
        const { parseDocument } = await import("../lib/parser");
        textContent = await parseDocument(buffer, filename);
      } catch (e) {
        console.log(`  ✗ Parse error: ${(e as Error).message}\n`);
        failed++;
        continue;
      }
    } else {
      content = fs.readFileSync(filePath, "utf-8");
      textContent = content;
    }

    console.log(`[${i + 1}/${files.length}] ${filename} (${(textContent.length / 1000).toFixed(1)}k chars)`);

    try {
      // Generate summary
      process.stdout.write("  → Generating summary... ");
      const { summary, keywords } = await generateSummary(textContent, filename);
      console.log("✓");
      console.log(`    Summary: ${summary.slice(0, 80)}...`);
      console.log(`    Keywords: ${keywords.join(", ")}`);

      // Save to Blob (summary includes all metadata, no separate index needed)
      process.stdout.write("  → Saving to Blob... ");
      await blobSet(`docs/${docId}.txt`, textContent);
      await blobSet(
        `summary/${docId}.json`,
        JSON.stringify({ docId, filename, summary, keywords, charCount: textContent.length, uploadedAt: new Date().toISOString() })
      );
      console.log("✓\n");

      success++;
    } catch (e) {
      console.log(`✗ Error: ${(e as Error).message}\n`);
      failed++;
    }

    // Small delay to avoid rate limiting
    if (i < files.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\n✅ Done! Success: ${success}, Failed: ${failed}, Total: ${files.length}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
