/**
 * Stop active run.
 */
export async function onRequest(context: any) {
  const { request, utils } = context;
  const body = request?.body ?? {};
  const conversationId = body.conversation_id || context.conversation_id;

  if (!conversationId) {
    return new Response(JSON.stringify({ error: "Missing conversation_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = utils.abortActiveRun(conversationId);
  return new Response(JSON.stringify(result), {
    status: result.aborted ? 200 : 404,
    headers: { "Content-Type": "application/json" },
  });
}
