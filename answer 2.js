// Kalem Cevap: forwards the page's request to Google Gemini and streams the answer back.
// The API key stays here on the server. The browser never sees it.
//
// Netlify environment variables:
//   GEMINI_API_KEY  required  free key from https://aistudio.google.com/apikey
//   ACCESS_CODE     optional  if set, the page asks for this code before answering
//   MODEL           optional  default: gemini-flash-latest

export default async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) return new Response("GEMINI_API_KEY is not set on the server.", { status: 500 });

  const code = Netlify.env.get("ACCESS_CODE");
  if (code && request.headers.get("x-access-code") !== code) {
    return new Response("Wrong access code.", { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { return new Response("Bad request.", { status: 400 }); }
  const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 260000) : "";
  if (!prompt) return new Response("Empty prompt.", { status: 400 });
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];

  const parts = [
    ...images.filter(s => typeof s === "string").map(data => ({ inline_data: { mime_type: "image/jpeg", data } })),
    { text: prompt + "\n\nYanıtın sadece JSON olsun. Başka metin yazma." },
  ];

  const model = Netlify.env.get("MODEL") || "gemini-flash-latest";
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { maxOutputTokens: 16000, responseMimeType: "application/json" },
      }),
    },
  );

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, { status: upstream.status === 429 ? 429 : 502 });
  }

  // Convert Gemini's stream into the simple event format the page reads.
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "";
  const send = (ctl, obj) => ctl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
  const handle = (ctl, line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    let ev; try { ev = JSON.parse(line.slice(5)); } catch { return; }
    if (ev.error) { send(ctl, { type: "error", error: { type: ev.error.status === "RESOURCE_EXHAUSTED" ? "overloaded_error" : "api_error", message: ev.error.message } }); return; }
    const c = ev.candidates && ev.candidates[0];
    if (!c) { if (ev.promptFeedback && ev.promptFeedback.blockReason) send(ctl, { type: "message_delta", delta: { stop_reason: "refusal" } }); return; }
    const text = ((c.content && c.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
    if (text) send(ctl, { type: "content_block_delta", delta: { type: "text_delta", text } });
    if (c.finishReason) {
      const r = c.finishReason === "MAX_TOKENS" ? "max_tokens" : c.finishReason === "SAFETY" || c.finishReason === "PROHIBITED_CONTENT" ? "refusal" : "end_turn";
      send(ctl, { type: "message_delta", delta: { stop_reason: r } });
    }
  };
  const stream = upstream.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { handle(ctl, buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    flush(ctl) { if (buf) handle(ctl, buf); },
  }));

  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
};

export const config = { path: "/api/answer" };
