// Kalem Cevap: sends the page's request to Google Gemini and streams the answer back.
// Netlify environment variables: GEMINI_API_KEY (required), ACCESS_CODE and MODEL (optional).
// Test page: open /api/answer?test in the browser.

const API = "https://generativelanguage.googleapis.com/v1beta/";
const PREFERRED = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"];
let chosen = null;

async function listModels(key) {
  const r = await fetch(API + "models?pageSize=200", { headers: { "x-goog-api-key": key } });
  if (!r.ok) return { error: r.status + " " + (await r.text()).slice(0, 400), names: [] };
  const j = await r.json();
  const names = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""));
  return { names };
}

function pickFrom(names) {
  for (const p of PREFERRED) if (names.includes(p)) return p;
  const ok = names.filter(n => /flash/.test(n) && !/(lite|tts|live|image|audio|embed|transcribe|translate)/.test(n));
  ok.sort().reverse();
  return ok[0] || names[0] || null;
}

function callGemini(key, model, parts, stream) {
  return fetch(API + "models/" + encodeURIComponent(model) + (stream ? ":streamGenerateContent?alt=sse" : ":generateContent"), {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: stream ? { maxOutputTokens: 16000, responseMimeType: "application/json" } : { maxOutputTokens: 50 },
    }),
  });
}

async function startGemini(key, parts, stream) {
  const envModel = Netlify.env.get("MODEL");
  let model = envModel || chosen || PREFERRED[0];
  let res = await callGemini(key, model, parts, stream);
  if (res.status === 404 && !envModel) {
    const { names } = await listModels(key);
    const next = pickFrom(names);
    if (next && next !== model) { model = next; res = await callGemini(key, model, parts, stream); }
  }
  if (res.ok) chosen = model;
  return { res, model };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async (request) => {
  const key = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  const url = new URL(request.url);

  if (request.method === "GET" && url.searchParams.has("test")) {
    if (!key) return json({ sonuc: "HATA", neden: "GEMINI_API_KEY Netlify'da yok." });
    const { res, model } = await startGemini(key, [{ text: "Sadece Merhaba yaz." }], false);
    const text = await res.text();
    const models = res.ok ? undefined : await listModels(key);
    return json({
      sonuc: res.ok ? "CALISIYOR" : "HATA",
      model,
      durum: res.status,
      anahtar_basi: key.slice(0, 4) + "...",
      cevap: text.slice(0, 600),
      kullanilabilir_modeller: models ? (models.error || models.names.slice(0, 30)) : undefined,
    });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!key) return new Response("GEMINI_API_KEY is not set on the server.", { status: 500 });

  const code = Netlify.env.get("ACCESS_CODE");
  if (code && request.headers.get("x-access-code") !== code) return new Response("Wrong access code.", { status: 401 });

  let body;
  try { body = await request.json(); } catch { return new Response("Bad request.", { status: 400 }); }
  const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 260000) : "";
  if (!prompt) return new Response("Empty prompt.", { status: 400 });
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];

  const parts = [
    ...images.filter(s => typeof s === "string").map(data => ({ inline_data: { mime_type: "image/jpeg", data } })),
    { text: prompt + "\n\nYanıtın sadece JSON olsun. Başka metin yazma." },
  ];

  const { res: upstream } = await startGemini(key, parts, true);
  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, { status: upstream.status === 429 ? 429 : 502 });
  }

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
      const r = c.finishReason === "MAX_TOKENS" ? "max_tokens" : /SAFETY|PROHIBITED|BLOCK/.test(c.finishReason) ? "refusal" : "end_turn";
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
