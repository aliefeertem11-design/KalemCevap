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
    signal: AbortSignal.timeout(35000),
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
    const out = { anahtar_basi: key.slice(0, 4) + "...", anahtar_uzunlugu: key.length, adimlar: [] };
    const t0 = Date.now();
    const step = async (name, fn) => {
      const t = Date.now();
      try { const v = await fn(); out.adimlar.push({ adim: name, sure_ms: Date.now() - t, ...v }); return v; }
      catch (e) { out.adimlar.push({ adim: name, sure_ms: Date.now() - t, hata: String(e && e.message || e) }); return null; }
    };
    const lm = await step("1 Google'a baglanti ve model listesi", async () => {
      const r = await fetch(API + "models?pageSize=200", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(12000) });
