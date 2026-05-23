/**
 * Shared utilities for RAG knowledge base agent.
 */
import { ChatOpenAI } from "@langchain/openai";

let cachedModel: ChatOpenAI | null = null;

export function createModel(): ChatOpenAI {
  if (cachedModel) return cachedModel;


  cachedModel = new ChatOpenAI({
    model: process.env.AI_MODEL || "@Pages/deepseek-v4-flash",
    apiKey: process.env.AI_GATEWAY_API_KEY!,
    configuration: {
      baseURL: process.env.AI_GATEWAY_BASE_URL!,
    },
    timeout: 300_000,
  });

  return cachedModel;
}

export function createLogger(name: string) {
  return {
    log(...args: unknown[]) {
      console.log(`[${name}][${new Date().toISOString()}]`, ...args);
    },
    error(...args: unknown[]) {
      console.error(`[${name}][${new Date().toISOString()}]`, ...args);
    },
  };
}

export function createSSEResponse(
  generator: AsyncGenerator<string>,
  signal?: AbortSignal
): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "ping", ts: Date.now() })}\n\n`));
        } catch {}
      }, 5_000);
      try {
        for await (const chunk of generator) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e) {
        const error = e as Error;
        if (error.name !== "AbortError" && !signal?.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error_message", content: error.message })}\n\n`));
        }
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
    cancel() {},
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}
