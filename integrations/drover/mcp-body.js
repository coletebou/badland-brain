// The body of a streamable-HTTP MCP reply: a JSON-RPC message, a JSON array of messages, or a text/event-stream body
// whose `data:` lines carry them. Returns the messages in order; comments, keep-alives and non-JSON events are skipped.
export function parseMcpBody(contentType, text) {
  const body = String(text ?? '');
  if (!body.trim()) return [];
  const type = String(contentType ?? '').toLowerCase();
  const looksLikeEvents = /^(?:event|data|id|retry):/m.test(body);
  if (!type.includes('text/event-stream') && (type.includes('json') || !looksLikeEvents)) {
    const value = JSON.parse(body);
    return Array.isArray(value) ? value : [value];
  }
  const messages = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length === 0) continue;
    let value;
    try { value = JSON.parse(data.join('\n')); } catch { continue; }
    messages.push(...(Array.isArray(value) ? value : [value]));
  }
  return messages;
}
