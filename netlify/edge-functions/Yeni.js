// Kalem Cevap: sends the page's request to Google Gemini and streams the answer back.
// Netlify environment variables: GEMINI_API_KEY (required), ACCESS_CODE and MODEL (optional).
// Test page: open /api/answer?test in the browser.

const API = "https://generativelanguage.googleapis.com/v1beta/";
const PREFERRED = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"];
let chosen = null;

async function listModels(key) {
  const r = await fetch(API + "models?pageSize=200", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10000) });
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
    signal: AbortSignal.timeout(170000),
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: stream ? { maxOutputTokens: 16000, responseMimeType: "application/json" } : { maxOutputTokens: 50 },
    }),
  });
}

// Try models in order. If one is busy (503), over its free quota (429), missing (404)
// or failing (500), move on to the next one.
const FALLBACK = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
async function startGemini(key, parts, stream) {
  const envModel = Netlify.env.get("MODEL");
  const order = [...new Set([envModel, chosen, ...FALLBACK].filter(Boolean))];
  let res = null, model = null, tries = 0;
  for (const m of order) {
    if (tries >= 5) break;
    tries++;
    model = m;
    res = await callGemini(key, m, parts, stream);
    if (res.ok) { chosen = m; return { res, model }; }
    if (![404, 429, 500, 503].includes(res.status)) break;
    if (res.status === 503 && m === chosen) chosen = null;
  }
  return { res, model };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export default async (request) => {
  const key = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  const url = new URL(request.url);

  if (request.method === "GET" && url.searchParams.has("test")) {
    if (!key) return json({ sonuc: "HATA", neden: "GEMINI_API_KEY Netlify'da yok." });
    const out = { anahtar_basi: key.slice(0, 4) + "...", anahtar_uzunlugu: key.length, adimlar: [] };
    const t0 = Date.now();
    const step = async (name, fn) => {
      const t = Date.now();
      try { const v = await fn(); out.adimlar.push({ adim: name, sure_ms: Date.now() - t, ...v }); return v; }
      catch (e) { out.adimlar.push({ adim: name, sure_ms: Date.now() - t, hata: String(e && e.message || e) }); return null; }
    };
    const lm = await step("1 Google'a baglanti ve model listesi", async () => {
      const r = await fetch(API + "models?pageSize=200", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(12000) });
      const txt = await r.text();
      if (!r.ok) return { durum: r.status, cevap: txt.slice(0, 400) };
      const names = (JSON.parse(txt).models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
      return { durum: r.status, modeller: names.slice(0, 40) };
    });
    const model = Netlify.env.get("MODEL") || (lm && lm.modeller ? pickFrom(lm.modeller) : PREFERRED[0]) || PREFERRED[0];
    await step("2 Kisa soru (" + model + ")", async () => {
      const r = await fetch(API + "models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST", signal: AbortSignal.timeout(20000),
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Sadece Merhaba yaz." }] }], generationConfig: { maxOutputTokens: 200 } }),
      });
      return { durum: r.status, cevap: (await r.text()).slice(0, 400) };
    });
    const last = out.adimlar[out.adimlar.length - 1];
    out.sonuc = last && last.durum === 200 ? "CALISIYOR" : "HATA";
    out.toplam_ms = Date.now() - t0;
    return json(out);
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

  // Answer right away and keep the connection alive while Gemini thinks,
  // so Netlify's 40 second limit for the first response never hits.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (obj) => ctl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
      const fail = (type, message) => { send({ type: "error", error: { type, message } }); ctl.close(); };
      ctl.enqueue(enc.encode(": start\n\n"));
      const ping = setInterval(() => { try { ctl.enqueue(enc.encode(": ping\n\n")); } catch {} }, 5000);
      let upstream;
      try { ({ res: upstream } = await startGemini(key, parts, true)); }
      catch (e) { clearInterval(ping); return fail("api_error", "Gemini did not answer in time: " + String(e && e.message || e)); }
      if (!upstream.ok) {
        clearInterval(ping);
        const text = (await upstream.text()).slice(0, 500);
        return fail(upstream.status === 429 ? "overloaded_error" : "api_error", upstream.status + " " + text);
      }
      const dec = new TextDecoder();
      let buf = "";
      const handle = (line) => {
        line = line.trim();
        if (!line.startsWith("data:")) return;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { return; }
        if (ev.error) { send({ type: "error", error: { type: ev.error.status === "RESOURCE_EXHAUSTED" ? "overloaded_error" : "api_error", message: ev.error.message } }); return; }
        const c = ev.candidates && ev.candidates[0];
        if (!c) { if (ev.promptFeedback && ev.promptFeedback.blockReason) send({ type: "message_delta", delta: { stop_reason: "refusal" } }); return; }
        const text = ((c.content && c.content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
        if (text) send({ type: "content_block_delta", delta: { type: "text_delta", text } });
        if (c.finishReason) {
          const r = c.finishReason === "MAX_TOKENS" ? "max_tokens" : /SAFETY|PROHIBITED|BLOCK/.test(c.finishReason) ? "refusal" : "end_turn";
          send({ type: "message_delta", delta: { stop_reason: r } });
        }
      };
      try {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
        }
        if (buf) handle(buf);
      } catch (e) {
        send({ type: "error", error: { type: "api_error", message: String(e && e.message || e) } });
      }
      clearInterval(ping);
      ctl.close();
    },
  });

  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
};

export const config = { path: "/api/answer" };
