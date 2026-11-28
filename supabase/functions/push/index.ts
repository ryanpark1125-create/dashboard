// push: morning notification (tasks, today's schedule, weather) for the dashboard, sent by Web Push.
// Devices subscribe with their sync code. A scheduled job calls action "cron" every few minutes and
// each device gets one notification per day at its chosen local time. Signing keys are created on
// first use and kept in dashboard_push_config; nothing secret is sent to the page.
import * as webpush from "jsr:@negrel/webpush";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SITE = "https://ryanpark1125-create.github.io/dashboard/";
// Only real browser push services are ever contacted.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.apple\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_SUBS = 10, WINDOW_MIN = 180;

// deno-lint-ignore no-explicit-any
type Any = any;
type Sub = { id: string; code: string; endpoint: string; p256dh: string; auth: string; tz: string; send_at: string; lat: number | null; lon: number | null; place: string; last_sent: string };

const b64uToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pushServer(db: Any) {
  let row = (await db.from("dashboard_push_config").select("value").eq("key", "vapid").maybeSingle()).data;
  if (!row) {
    const keys = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(keys);
    await db.from("dashboard_push_config").insert({ key: "vapid", value: JSON.stringify(exported) });
    row = (await db.from("dashboard_push_config").select("value").eq("key", "vapid").maybeSingle()).data; // re-read in case another call won the race
  }
  const jwk = JSON.parse(row.value);
  const vapidKeys = await webpush.importVapidKeys(jwk, { extractable: false });
  const server = await webpush.ApplicationServer.new({ contactInformation: SITE, vapidKeys });
  const raw = new Uint8Array(65);
  raw[0] = 4; raw.set(b64uToBytes(jwk.publicKey.x), 1); raw.set(b64uToBytes(jwk.publicKey.y), 33);
  return { server, publicKey: bytesToB64u(raw) };
}

// ---- local time helpers
function local(tz: string, d = new Date()) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) p[x.type] = x.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  const minutes = (+p.hour % 24) * 60 + +p.minute;
  const wd = (new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay() + 6) % 7; // Mon = 0
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return { date, minutes, wd, offsetMs: asUtc - Math.floor(d.getTime() / 60000) * 60000 };
}
const toMin = (t: string) => { const [a, b] = String(t || "").split(":").map(Number); return (a || 0) * 60 + (b || 0); };
const clock = (m: number) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`; };
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
function occursOn(e: Any, ds: string) {
  if (!e || !e.date || ds < e.date) return false;
  if (Array.isArray(e.exceptions) && e.exceptions.includes(ds)) return false;
  const r = e.repeat || "none";
  if (r === "none") return ds === e.date;
  const diff = dayDiff(e.date, ds);
  if (r === "daily") return true;
  if (r === "weekly") return diff % 7 === 0;
  if (r === "fortnightly") return diff % 14 === 0;
  if (r === "monthly") return ds.slice(8) === e.date.slice(8);
  return false;
}

const WMO: Record<number, string> = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow", 80: "light showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers", 95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail" };
async function weatherLine(sub: Sub): Promise<string> {
  if (sub.lat == null || sub.lon == null) return "";
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${sub.lat}&longitude=${sub.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=${encodeURIComponent(sub.tz)}&forecast_days=1`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return "";
    const d = (await r.json()).daily;
    const hi = Math.round(d.temperature_2m_max[0]), lo = Math.round(d.temperature_2m_min[0]), rain = d.precipitation_probability_max?.[0];
    const desc = WMO[d.weather_code[0]] ?? "";
    return `${sub.place ? sub.place + ": " : ""}${lo}° to ${hi}°${desc ? ", " + desc : ""}${rain != null && rain >= 20 ? `, ${rain}% chance of rain` : ""}`;
  } catch (_) { return ""; }
}

async function compose(db: Any, sub: Sub) {
  const now = local(sub.tz);
  const row = (await db.from("dashboard_sync").select("data").eq("code", sub.code).maybeSingle()).data;
  const S: Any = row?.data ?? {};
  // tasks
  const open = (Array.isArray(S.tasks) ? S.tasks : []).filter((t: Any) => t && !t.done && t.due);
  const uni = (Array.isArray(S.uni) ? S.uni : []).filter((u: Any) => u && !u.done && u.due);
  const today = [...open, ...uni].filter((t: Any) => t.due === now.date).map((t: Any) => String(t.title || "").trim()).filter(Boolean);
  const overdue = [...open, ...uni].filter((t: Any) => t.due < now.date).length;
  let tasks = today.length
    ? `${today.length} due today: ${today.slice(0, 3).join(", ")}${today.length > 3 ? ` +${today.length - 3} more` : ""}`
    : "Nothing due today";
  if (overdue) tasks += ` · ${overdue} overdue`;
  // schedule: own events, weekly blocks, Google Calendar
  const items: { m: number; t: string }[] = [];
  for (const e of Array.isArray(S.events) ? S.events : []) if (occursOn(e, now.date)) items.push({ m: e.allDay || !e.time ? -1 : toMin(e.time), t: String(e.title || "") });
  for (const b of Array.isArray(S.fixedBlocks) ? S.fixedBlocks : []) if (b && b.day === now.wd && !/uni\s*placement/i.test(b.title || "")) items.push({ m: b.start ? toMin(b.start) : -1, t: String(b.title || "") });
  try {
    const dayStart = Date.parse(now.date + "T00:00:00Z") - now.offsetMs;
    const r = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/gcal", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ action: "events", code: sub.code, from: new Date(dayStart).toISOString(), to: new Date(dayStart + 864e5).toISOString() }),
    });
    if (r.ok) for (const e of (await r.json()).events ?? []) {
      if (e.allDay) { if (e.start <= now.date && now.date < e.end) items.push({ m: -1, t: String(e.title) }); }
      else { const l = local(sub.tz, new Date(e.start)); if (l.date === now.date) items.push({ m: l.minutes, t: String(e.title) }); }
    }
  } catch (_) { /* calendar is optional */ }
  items.sort((a, b) => a.m - b.m);
  const sched = items.length
    ? "Today: " + items.slice(0, 4).map((i) => (i.m < 0 ? "" : clock(i.m) + " ") + i.t).join(", ") + (items.length > 4 ? ` +${items.length - 4} more` : "")
    : "";
  const weather = await weatherLine(sub);
  const dateLabel = new Intl.DateTimeFormat("en-AU", { timeZone: sub.tz, weekday: "short", day: "numeric", month: "short" }).format(new Date());
  return { title: `Good morning · ${dateLabel}`, body: [weather, tasks, sched].filter(Boolean).join("\n"), url: SITE, localDate: now.date, minutes: now.minutes };
}

async function deliver(server: Any, db: Any, sub: Sub, payload: { title: string; body: string; url: string }) {
  try {
    const s = server.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
    await s.pushTextMessage(JSON.stringify({ title: payload.title, body: payload.body, url: payload.url }), { ttl: 6 * 3600 });
    return { ok: true };
  } catch (e) {
    const gone = e instanceof webpush.PushMessageError && e.isGone();
    if (gone) await db.from("dashboard_push_subs").delete().eq("id", sub.id); // the device turned notifications off
    return { ok: false, gone, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: Any;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  const action = String(b.action || "");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  try {
    // ---- scheduler: send to every device whose morning time has arrived and that hasn't had today's yet
    if (action === "cron") {
      const secret = (await db.from("dashboard_push_config").select("value").eq("key", "cron_secret").maybeSingle()).data?.value;
      if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "forbidden" }, 403);
      const subs = (await db.from("dashboard_push_subs").select("*")).data as Sub[] ?? [];
      let sent = 0, failed = 0; const due: Sub[] = [];
      for (const s of subs) {
        let now; try { now = local(s.tz); } catch { continue; }
        const at = toMin(s.send_at);
        if (s.last_sent !== now.date && now.minutes >= at && now.minutes < at + WINDOW_MIN) due.push(s);
      }
      if (due.length) {
        const { server } = await pushServer(db);
        for (const s of due) {
          const p = await compose(db, s);
          const r = await deliver(server, db, s, p);
          if (r.ok) { sent++; await db.from("dashboard_push_subs").update({ last_sent: p.localDate }).eq("id", s.id); } else failed++;
        }
      }
      return json({ checked: subs.length, sent, failed });
    }

    const code = String(b.code || "");
    if (code.length < 12 || code.length > 80 || code.includes(":")) return json({ error: "code" }, 401);
    const known = await db.from("dashboard_sync").select("code").eq("code", code).maybeSingle();
    if (known.error) return json({ error: "server" }, 500);
    if (!known.data) return json({ error: "code" }, 401);

    if (action === "vapid") return json({ key: (await pushServer(db)).publicKey });

    if (action === "subscribe") {
      const sub = b.sub ?? {};
      let host = "";
      try { const u = new URL(String(sub.endpoint)); if (u.protocol !== "https:") throw 0; host = u.hostname; } catch { return json({ error: "That device's notification address isn't valid." }, 400); }
      if (!PUSH_HOSTS.some((re) => re.test(host))) return json({ error: "This browser's notification service isn't supported." }, 400);
      const p256dh = String(sub.keys?.p256dh || ""), auth = String(sub.keys?.auth || "");
      if (!p256dh || !auth) return json({ error: "That device's notification keys are missing." }, 400);
      const tz = String(b.tz || "Australia/Sydney");
      try { local(tz); } catch { return json({ error: "Unknown time zone." }, 400); }
      const send_at = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time)) ? String(b.time) : "07:00";
      const lat = Number.isFinite(+b.lat) && Math.abs(+b.lat) <= 90 && b.lat !== null && b.lat !== "" ? +b.lat : null;
      const lon = Number.isFinite(+b.lon) && Math.abs(+b.lon) <= 180 && b.lon !== null && b.lon !== "" ? +b.lon : null;
      const place = String(b.place || "").slice(0, 80);
      const existing = (await db.from("dashboard_push_subs").select("id,endpoint").eq("code", code)).data ?? [];
      if (!existing.some((x: Any) => x.endpoint === sub.endpoint) && existing.length >= MAX_SUBS) return json({ error: `Notifications are already on for ${MAX_SUBS} devices. Turn one off first.` }, 400);
      const up = await db.from("dashboard_push_subs").upsert({ code, endpoint: String(sub.endpoint), p256dh, auth, tz, send_at, lat: lat != null && lon != null ? lat : null, lon: lat != null && lon != null ? lon : null, place }, { onConflict: "endpoint" });
      return up.error ? json({ error: "server" }, 500) : json({ ok: true, time: send_at });
    }

    if (action === "unsubscribe") {
      const r = await db.from("dashboard_push_subs").delete().eq("code", code).eq("endpoint", String(b.endpoint || ""));
      return r.error ? json({ error: "server" }, 500) : json({ ok: true });
    }

    if (action === "test" || action === "preview") {
      const sub = (await db.from("dashboard_push_subs").select("*").eq("code", code).eq("endpoint", String(b.endpoint || "")).maybeSingle()).data as Sub | null;
      if (!sub) return json({ error: "Notifications aren't turned on for this device yet." }, 404);
      const p = await compose(db, sub);
      if (action === "preview") return json({ title: p.title, body: p.body });
      const { server } = await pushServer(db);
      const r = await deliver(server, db, sub, p);
      return r.ok ? json({ ok: true, title: p.title, body: p.body }) : json({ error: r.gone ? "This device is no longer registered for notifications. Turn them on again." : "Couldn't send: " + r.error }, 502);
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    return json({ error: "server: " + String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
