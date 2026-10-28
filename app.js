"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const load = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const keep = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------- Almacenamiento: Firebase o, sin configuración, modo prueba local ----------

function makeFirebaseStore(cfg) {
  firebase.initializeApp(cfg);
  const db = firebase.database();
  let offset = 0;
  db.ref(".info/serverTimeOffset").on("value", s => offset = s.val() || 0);
  return {
    local: false,
    ready: firebase.auth().signInAnonymously(),
    now: () => Date.now() + offset,
    sub(path, cb) { const r = db.ref(path); const h = r.on("value", s => cb(s.val())); return () => r.off("value", h); },
    update: (path, obj) => db.ref(path).update(obj),
    set: (path, v) => db.ref(path).set(v),
    push: (path, v) => db.ref(path).push(v),
    get: path => db.ref(path).get().then(s => s.val())
  };
}

// Guarda todo en localStorage y avisa a las demás pestañas del mismo navegador.
function makeLocalStore() {
  const KEY = "manhunt-local-db";
  let subs = [];
  const read = () => load(KEY) || {};
  const keys = path => path.split("/").filter(Boolean);
  const getAt = (o, path) => keys(path).reduce((a, k) => a == null ? undefined : a[k], o);
  const setAt = (o, path, v) => {
    const ks = keys(path); let a = o;
    ks.slice(0, -1).forEach(k => { if (typeof a[k] !== "object" || a[k] === null) a[k] = {}; a = a[k]; });
    if (v === null) delete a[ks.at(-1)]; else a[ks.at(-1)] = v;
  };
  // Como Firebase, avisa a los suscriptores después de la escritura, no durante.
  const notify = () => { const d = read(); subs.forEach(s => s.cb(getAt(d, s.path) ?? null)); };
  const write = fn => { const d = read(); fn(d); keep(KEY, d); setTimeout(notify); return Promise.resolve(); };
  addEventListener("storage", e => { if (e.key === KEY) notify(); });
  return {
    local: true,
    ready: Promise.resolve(),
    now: () => Date.now(),
    sub(path, cb) { const s = {path, cb}; subs.push(s); setTimeout(() => cb(getAt(read(), path) ?? null)); return () => { subs = subs.filter(x => x !== s); }; },
    update: (path, obj) => write(d => Object.entries(obj).forEach(([k, v]) => setAt(d, path + "/" + k, v))),
    set: (path, v) => write(d => setAt(d, path, v)),
    push: (path, v) => write(d => setAt(d, path + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), v)),
    get: path => Promise.resolve(getAt(read(), path) ?? null)
  };
}

const store = window.FIREBASE_CONFIG ? makeFirebaseStore(window.FIREBASE_CONFIG) : makeLocalStore();

// ---------- Estado ----------

// Cada pestaña es un jugador distinto en modo prueba, así que su id va en sessionStorage.
const idStore = store.local ? sessionStorage : localStorage;
let pid = (() => { try { return idStore.getItem("manhunt-pid"); } catch { return null; } })();
if (!pid) { pid = Math.random().toString(36).slice(2, 10); try { idStore.setItem("manhunt-pid", pid); } catch {} }

let code = null, G = null, unsub = null, picking = null;
let myPos = null, geoWatch = null, geoError = null, wakeLock = null;
let lastPingKey = null, endingRound = null;
const gpath = (...p) => ["games", code, ...p].join("/");

const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const fmtClock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const ago = t => { const s = Math.max(0, Math.round((store.now() - t) / 1000)); return s < 60 ? `hace ${s} s` : `hace ${Math.floor(s / 60)} min`; };

const players = () => G?.players || {};
const catches = () => G?.rounds?.[G.round]?.catches || {};
// Un corredor atrapado pasa a ser cazador durante el resto de la ronda.
const roleOf = id => catches()[id] ? "hunter" : players()[id]?.startRole;
const ids = () => Object.keys(players()).sort((a, b) => (players()[a].joinedAt || 0) - (players()[b].joinedAt || 0));
const runnerIds = () => ids().filter(id => roleOf(id) === "runner");
const hunterIds = () => ids().filter(id => roleOf(id) === "hunter");
const pendingIds = () => ids().filter(id => !players()[id].startRole);
const isHost = () => G?.host === pid;
const status = () => G?.state?.status || "idle";
const isLive = () => status() === "running" || status() === "paused";
const DEFAULTS = {durMin: 20, headSec: 60, pingSec: 300, hunters: 1, radius: 800};
const settings = () => ({...DEFAULTS, ...(G?.settings || {})});
// Distancia en metros desde el centro de la zona; null si aún no hay zona.
const distToZone = (lat, lng) => { const a = settings().area; return a ? L.latLng(a.lat, a.lng).distanceTo([lat, lng]) : null; };
const outside = (lat, lng) => { const d = distToZone(lat, lng); return d != null && d > settings().radius; };

function elapsed() {
  const st = G?.state; if (!st || st.status === "idle") return 0;
  const end = st.status === "paused" ? st.pausedAt : st.status === "ended" ? st.endedAt : store.now();
  return Math.max(0, end - st.startedAt - (st.pausedTotal || 0));
}
const log = (kind, text) => store.push(gpath("log"), {round: G.round, t: elapsed(), kind, text});

// ---------- Entrar y salir ----------

const randomCode = () => Array.from({length: 5}, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const joinError = msg => { const e = $("#joinError"); e.textContent = msg; e.hidden = !msg; };

function joinInputs() {
  const name = $("#nameIn").value.trim();
  if (!name) { joinError("Escribe tu nombre."); $("#nameIn").focus(); return null; }
  keep("manhunt-name", name);
  return {name};
}

$("#createBtn").onclick = async () => {
  const me = joinInputs(); if (!me) return;
  await store.ready;
  const c = randomCode();
  await store.set(`games/${c}`, {host: pid, created: store.now(), round: 1, settings: DEFAULTS, state: {status: "idle"}, players: {[pid]: {...me, joinedAt: store.now()}}});
  enterGame(c);
};

$("#joinForm").onsubmit = async ev => {
  ev.preventDefault();
  const me = joinInputs(); if (!me) return;
  const c = $("#codeIn").value.trim().toUpperCase();
  if (c.length !== 5) { joinError("El código tiene 5 letras o números."); return; }
  await store.ready;
  const game = await store.get(`games/${c}`);
  if (!game) { joinError(`No existe ninguna partida con el código ${c}.`); return; }
  // Quien se une sin estar ya dentro queda esperando al sorteo.
  if (!game.players?.[pid]) me.joinedAt = store.now();
  await store.update(`games/${c}/players/${pid}`, me);
  enterGame(c);
};

function enterGame(c) {
  code = c; keep("manhunt-code", c);
  history.replaceState(null, "", "#" + c);
  $("#joinScreen").hidden = true; $("#gameScreen").hidden = false;
  $("#codeChip").textContent = c;
  initMap();
  startGeo();
  unsub = store.sub(`games/${c}`, g => {
    if (!g) { leave(); joinError("La partida ya no existe."); return; }
    G = g; render();
  });
}

function leave() {
  unsub?.(); unsub = null; G = null; code = null; keep("manhunt-code", null);
  if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null;
  wakeLock?.release?.(); wakeLock = null;
  history.replaceState(null, "", location.pathname);
  $("#gameScreen").hidden = true; $("#joinScreen").hidden = false;
}
$("#leaveBtn").onclick = leave;

$("#shareBtn").onclick = async () => {
  const url = location.origin + location.pathname + "#" + code;
  try { await navigator.clipboard.writeText(url); $("#shareBtn").textContent = "Enlace copiado"; }
  catch { prompt("Copia este enlace:", url); }
  setTimeout(() => $("#shareBtn").textContent = "Copiar enlace", 2000);
};

// ---------- Ubicación ----------

function startGeo() {
  if (!("geolocation" in navigator)) { geoError = "Este navegador no permite leer la ubicación."; return; }
  if (geoWatch != null) return;
  geoWatch = navigator.geolocation.watchPosition(
    p => { myPos = {lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy)}; geoError = null; drawMe(); },
    e => { geoError = e.code === 1 ? "No has dado permiso de ubicación. Actívalo en los ajustes del navegador para esta web." : "No se pudo obtener tu ubicación. Comprueba que el GPS está activado."; renderGeoNotice(); },
    {enableHighAccuracy: true, maximumAge: 5000, timeout: 20000}
  );
  keepAwake();
}

// La pantalla tiene que seguir encendida: con el móvil bloqueado el navegador deja de leer el GPS.
async function keepAwake() {
  try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => wakeLock = null); } } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && code) keepAwake(); });

function renderGeoNotice() {
  const n = $("#geoNotice");
  const runner = G && roleOf(pid) === "runner";
  if (geoError) { n.className = "notice"; n.innerHTML = `${esc(geoError)} <button class="small" id="retryGeo">Reintentar</button>`; n.hidden = false; $("#retryGeo").onclick = () => { geoWatch != null && navigator.geolocation.clearWatch(geoWatch); geoWatch = null; startGeo(); }; }
  else if (runner && !myPos) { n.className = "notice"; n.textContent = "Buscando tu ubicación… Eres corredor: tus pings se mandan solos mientras tengas esta página abierta."; n.hidden = false; }
  else if (runner) { n.className = "notice ok"; n.textContent = "Eres corredor: mantén esta página abierta y la pantalla encendida para que se manden tus pings."; n.hidden = false; }
  else n.hidden = true;
}

// Todos los corredores mandan su posición a la vez, cada pingSec segundos tras la ventaja.
function pingSlot() {
  const {headSec, pingSec} = settings(), e = elapsed();
  if (status() !== "running" || e < headSec * 1000) return null;
  return Math.floor((e - headSec * 1000) / (pingSec * 1000));
}
function maybePing() {
  if (!G || roleOf(pid) !== "runner" || !myPos) return;
  const slot = pingSlot(); if (slot == null) return;
  const key = `${G.round}:${G.state.startedAt}:${slot}`;
  if (key === lastPingKey) return;
  lastPingKey = key;
  store.set(gpath("locs", pid), {...myPos, t: store.now(), round: G.round});
}

// ---------- Mapa ----------

let map = null, meMarker = null, meCircle = null, pins = {}, fitted = false;
function initMap() {
  if (map) { setTimeout(() => map.invalidateSize()); return; }
  map = L.map("map", {zoomControl: true}).setView([40.4168, -3.7038], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom: 19, attribution: "&copy; colaboradores de OpenStreetMap"}).addTo(map);
  map.on("click", e => { if (choosingZone && isHost() && !isLive()) setZone(e.latlng.lat, e.latlng.lng); });
  setTimeout(() => map.invalidateSize());
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawMe() {
  if (!map || !myPos) return;
  const ll = [myPos.lat, myPos.lng];
  if (!meMarker) {
    meCircle = L.circle(ll, {radius: myPos.acc, color: css("--me"), weight: 1, fillOpacity: .08}).addTo(map);
    meMarker = L.circleMarker(ll, {radius: 7, color: "#fff", weight: 2, fillColor: css("--me"), fillOpacity: 1}).addTo(map).bindTooltip("Tú", {className: "pin", direction: "top", offset: [0, -6]});
  } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(myPos.acc); }
  if (!fitted && !zoneCircle) { fitted = true; map.setView(ll, 16); }
}

function drawPins() {
  if (!map) return;
  const locs = G?.locs || {}, seen = new Set();
  for (const [id, l] of Object.entries(locs)) {
    if (l.round !== G.round || roleOf(id) !== "runner" || !players()[id]) continue;
    seen.add(id);
    const label = `${esc(players()[id].name)} <small>${ago(l.t)}${outside(l.lat, l.lng) ? " · fuera de zona" : ""}</small>`;
    if (!pins[id]) {
      pins[id] = L.circleMarker([l.lat, l.lng], {radius: 9, color: "#fff", weight: 2, fillColor: css("--runner"), fillOpacity: .95}).addTo(map)
        .bindTooltip(label, {permanent: true, className: "pin", direction: "top", offset: [0, -8]});
    } else { pins[id].setLatLng([l.lat, l.lng]).setTooltipContent(label); }
  }
  for (const id of Object.keys(pins)) if (!seen.has(id)) { pins[id].remove(); delete pins[id]; }
}

$("#fitBtn").onclick = () => {
  if (zoneCircle) return map.fitBounds(zoneCircle.getBounds().pad(0.05));
  const pts = Object.values(pins).map(m => m.getLatLng());
  if (myPos) pts.push(L.latLng(myPos.lat, myPos.lng));
  if (pts.length === 1) map.setView(pts[0], 17); else if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2));
};

// ---------- Zona de juego ----------

let zoneCircle = null, zoneMask = null, zoneKey = null, choosingZone = false;

// Anillo de puntos que aproxima el círculo, para recortar el sombreado de fuera.
function ringAround(lat, lng, r) {
  const R = 6378137, pts = [];
  for (let i = 0; i < 72; i++) {
    const a = i / 72 * 2 * Math.PI;
    pts.push([lat + (r * Math.cos(a) / R) * 180 / Math.PI, lng + (r * Math.sin(a) / (R * Math.cos(lat * Math.PI / 180))) * 180 / Math.PI]);
  }
  return pts;
}

function drawZone() {
  if (!map) return;
  const {area, radius} = settings();
  const key = area ? `${area.lat},${area.lng},${radius}` : null;
  if (key === zoneKey) return;
  zoneKey = key;
  zoneCircle?.remove(); zoneMask?.remove(); zoneCircle = zoneMask = null;
  if (!area) return;
  zoneMask = L.polygon([[[85, -180], [85, 180], [-85, 180], [-85, -180]], ringAround(area.lat, area.lng, radius)],
    {stroke: false, fillColor: "#000", fillOpacity: .35, interactive: false}).addTo(map);
  zoneCircle = L.circle([area.lat, area.lng], {radius, color: css("--hunter"), weight: 3, dashArray: "8 6", fill: false, interactive: false}).addTo(map);
  map.fitBounds(zoneCircle.getBounds().pad(0.05));
}

function setZone(lat, lng) {
  choosingZone = false; $("#map").classList.remove("choosing");
  store.update(gpath("settings"), {area: {lat: +lat.toFixed(6), lng: +lng.toFixed(6)}});
}
$("#pickZoneBtn").onclick = () => {
  choosingZone = !choosingZone;
  $("#map").classList.toggle("choosing", choosingZone);
  renderZoneBar();
};
$("#hereZoneBtn").onclick = () => myPos ? setZone(myPos.lat, myPos.lng) : flash("Todavía no tengo tu ubicación.");

function renderZoneBar() {
  const {area, radius} = settings(), canEdit = isHost() && !isLive();
  $("#pickZoneBtn").hidden = $("#hereZoneBtn").hidden = !canEdit;
  $("#pickZoneBtn").textContent = choosingZone ? "Cancelar" : area ? "Mover centro" : "Elegir centro en el mapa";
  $("#zoneHint").textContent = choosingZone ? "Toca el mapa donde quieras el centro de la zona."
    : area ? `Zona de ${radius} m de radio. Prohibido salir del círculo.`
    : isHost() ? "Elige el centro de la zona antes de empezar." : "El anfitrión todavía no ha elegido la zona.";
}

// ---------- Pitido de alarma ----------

// Los móviles solo dejan sonar audio después de que el jugador toque la pantalla,
// así que el primer toque en cualquier sitio prepara el sonido.
let audio = null;
function unlockAudio() {
  try {
    // En iPhone esto hace que suene aunque el interruptor de silencio esté puesto (iOS 16.4+).
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch {}
}
["pointerdown", "touchend", "keydown"].forEach(ev => addEventListener(ev, unlockAudio, {passive: true}));

function beep() {
  if (!audio) return;
  const t = audio.currentTime;
  [0, 0.25, 0.5].forEach((dt, i) => {
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "square"; o.frequency.value = i % 2 ? 660 : 880;
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.4, t + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.2);
    o.connect(g).connect(audio.destination);
    o.start(t + dt); o.stop(t + dt + 0.22);
  });
}
$("#testAlarmBtn").onclick = () => { unlockAudio(); setTimeout(beep, 50); navigator.vibrate?.([300, 150, 300]); };

// Aviso en el propio móvil al salir de la zona; queda apuntado en el registro.
// Mientras sigas fuera, el pitido se repite cada 4 segundos.
let wasOutside = false, lastBeep = 0;
function checkZone() {
  const alarm = $("#zoneAlarm");
  const out = !!(G && isLive() && myPos && outside(myPos.lat, myPos.lng));
  if (out) {
    const d = Math.round(distToZone(myPos.lat, myPos.lng) - settings().radius);
    alarm.textContent = `¡Estás fuera de la zona! Vuelve ${d} m hacia dentro.`;
    if (Date.now() - lastBeep > 4000) { lastBeep = Date.now(); beep(); }
  }
  alarm.hidden = !out;
  if (!isLive()) wasOutside = false;
  if (out !== wasOutside && G && isLive() && myPos) {
    wasOutside = out;
    if (out) navigator.vibrate?.([300, 150, 300]);
    log("z", out ? `${players()[pid].name} ha salido de la zona` : `${players()[pid].name} ha vuelto a la zona`);
  }
}

// ---------- Acciones ----------

// Baraja a todos los jugadores y los primeros N son cazadores. Devuelve false si no hay gente suficiente.
async function drawTeams() {
  const all = ids();
  if (all.length < 2) { flash("Hacen falta al menos 2 jugadores para sortear."); return false; }
  const n = Math.min(all.length - 1, Math.max(1, settings().hunters));
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const upd = {};
  all.forEach((id, i) => upd[`players/${id}/startRole`] = i < n ? "hunter" : "runner");
  await store.update(gpath(), upd);
  await log("i", `Sorteo: cazan ${all.slice(0, n).map(id => players()[id].name).join(", ")}. El resto corre.`);
  return true;
}

async function startRound() {
  const now = store.now();
  if (status() === "paused") {
    await store.update(gpath("state"), {status: "running", pausedTotal: (G.state.pausedTotal || 0) + (now - G.state.pausedAt), pausedAt: null});
    return log("i", "Ronda reanudada");
  }
  if (!settings().area) return flash("Primero elige la zona en el mapa.");
  // Si alguien no tiene equipo (ronda nueva o se acaba de unir), se sortea todo de nuevo.
  if (pendingIds().length) { if (!(await drawTeams())) return; }
  else if (!runnerIds().length || !hunterIds().length) return flash("Hace falta al menos un corredor y un cazador.");
  await store.update(gpath("state"), {status: "running", startedAt: now, pausedTotal: 0, pausedAt: null, endedAt: null});
  log("i", `Empieza la ronda ${G.round}. Los corredores tienen ${settings().headSec} s de ventaja.`);
}
async function pauseRound() {
  await store.update(gpath("state"), {status: "paused", pausedAt: store.now()});
  log("i", "Ronda en pausa");
}
async function endRound(winner, why) {
  const key = `${G.round}:${G.state.startedAt}`;
  if (!isLive() || endingRound === key) return;
  endingRound = key;
  const st = G.state, now = store.now();
  const pausedTotal = (st.pausedTotal || 0) + (st.status === "paused" ? now - st.pausedAt : 0);
  await store.update(gpath(), {"state/status": "ended", "state/endedAt": now, "state/pausedTotal": pausedTotal, [`rounds/${G.round}/winner`]: winner});
  log("i", why);
}
async function newRound() {
  if (isLive()) await endRound(runnerIds().length ? "r" : "h", "Ronda terminada antes de tiempo.");
  // Cada ronda se vuelve a sortear.
  const upd = {round: G.round + 1, state: {status: "idle"}, locs: null};
  ids().forEach(id => upd[`players/${id}/startRole`] = null);
  await store.update(gpath(), upd);
}
async function catchRunner(rid, by) {
  if (!isLive() || catches()[rid]) return;
  picking = null;
  const r = players()[rid], h = players()[by];
  const left = runnerIds().filter(id => id !== rid);
  await store.update(gpath(), {[`rounds/${G.round}/catches/${rid}`]: {by: by || null, t: elapsed()}, [`locs/${rid}`]: null});
  await log("c", `${h ? h.name : "Alguien"} atrapó a ${r.name}. Ahora ${r.name} es cazador.`);
  if (!left.length) endRound("h", "Todos atrapados. Ganan los cazadores.");
}

let flashTimer;
function flash(msg) {
  const b = $("#banner"); b.className = "banner h"; b.textContent = msg; b.hidden = false;
  clearTimeout(flashTimer); flashTimer = setTimeout(renderBanner, 2500);
}

$("#startBtn").onclick = startRound;
$("#pauseBtn").onclick = pauseRound;
$("#endBtn").onclick = () => endRound(runnerIds().length ? "r" : "h", runnerIds().length ? "Ronda terminada a mano. Ganan los corredores." : "Ronda terminada. Ganan los cazadores.");
$("#newBtn").onclick = newRound;
$("#drawBtn").onclick = drawTeams;
// [campo, ajuste, mínimo, máximo, unidades del campo por unidad guardada]
const FIELDS = [["dur", "durMin", 1, 180, 1], ["head", "headSec", 0, 600, 1], ["ping", "pingSec", 30, 1800, 1 / 60], ["hunters", "hunters", 1, 20, 1], ["radius", "radius", 100, 5000, 1]];
for (const [id, key, min, max, scale] of FIELDS) {
  $("#" + id).onchange = e => {
    const v = Math.min(max, Math.max(min, Math.round(+e.target.value / scale) || min));
    store.update(gpath("settings"), {[key]: v});
  };
}

document.addEventListener("click", ev => {
  const b = ev.target.closest("button[data-act]"); if (!b) return;
  const id = b.dataset.id;
  ({
    pick: () => { picking = id; render(); },
    cancel: () => { picking = null; render(); },
    catch: () => catchRunner(id, b.dataset.by),
    swap: () => store.update(gpath("players", id), {startRole: players()[id].startRole === "runner" ? "hunter" : "runner"}),
    kick: () => store.update(gpath(), {[`players/${id}`]: null, [`locs/${id}`]: null})
  })[b.dataset.act]();
});

// ---------- Pintar ----------

function renderBanner() {
  const b = $("#banner"), w = G?.rounds?.[G.round]?.winner;
  if (status() === "ended" && w) { b.hidden = false; b.className = "banner " + w; b.textContent = w === "h" ? "Ganan los cazadores" : "Ganan los corredores"; }
  else b.hidden = true;
}

function playerRow(id) {
  const p = players()[id], role = roleOf(id), c = catches()[id], live = isLive();
  let meta, actions = "";
  if (!role) {
    meta = "esperando sorteo";
  } else if (role === "runner") {
    const l = G.locs?.[id];
    meta = live ? (l && l.round === G.round ? `último ping ${ago(l.t)}` : "sin ping todavía") : "listo";
    if (live) actions += `<button class="small hunt" data-act="pick" data-id="${id}">${id === pid ? "Me han pillado" : "Pillado"}</button>`;
  } else {
    const n = Object.values(catches()).filter(x => x.by === id).length;
    meta = c ? `pillado en ${fmt(c.t)}${n ? ` · ${n} captura${n === 1 ? "" : "s"}` : ""}` : `${n} captura${n === 1 ? "" : "s"}`;
  }
  if (isHost() && !live) {
    if (role) actions += `<button class="small" data-act="swap" data-id="${id}" title="Cambiar de equipo" aria-label="Cambiar de equipo a ${esc(p.name)}">⇄</button>`;
    if (id !== pid) actions += `<button class="small" data-act="kick" data-id="${id}" title="Quitar de la partida" aria-label="Quitar a ${esc(p.name)}">✕</button>`;
  }
  const tag = [id === pid ? " (tú)" : "", G.host === id ? " · anfitrión" : ""].join("");
  let html = `<li class="player"><span class="avatar">${esc(p.name[0].toUpperCase())}</span><span><div class="pname">${esc(p.name)}<span class="muted" style="font-weight:400">${tag}</span></div><div class="pmeta">${meta}${c ? " · convertido" : ""}</div></span><span class="pact">${actions}</span>`;
  if (picking === id) {
    const hs = hunterIds().sort((a, b) => (b === pid) - (a === pid));
    html += `<div class="picker"><p>¿Quién atrapó a ${esc(p.name)}? Pasará a ser cazador.</p>${hs.map(h => `<button class="small" data-act="catch" data-id="${id}" data-by="${h}">${esc(players()[h].name)}</button>`).join("")}<button class="small" data-act="catch" data-id="${id}" data-by="">Sin especificar</button><button class="small" data-act="cancel">Cancelar</button></div>`;
  }
  return html + "</li>";
}

function render() {
  if (!G) return;
  if (!players()[pid]) { leave(); joinError("El anfitrión te ha quitado de la partida."); return; }
  const R = runnerIds(), H = hunterIds(), live = isLive(), s = settings();
  $("#roundLabel").textContent = `Ronda ${G.round}`;
  $("#runList").innerHTML = R.length ? R.map(playerRow).join("") : `<li class="empty">${live ? "No queda nadie suelto." : "Todavía no hay corredores."}</li>`;
  $("#huntList").innerHTML = H.length ? H.map(playerRow).join("") : `<li class="empty">Todavía no hay cazadores.</li>`;
  const P = pendingIds();
  $("#pendingBox").hidden = !P.length;
  $("#pendingBox").classList.add("pending");
  $("#pendList").innerHTML = P.map(playerRow).join("");
  $("#pendCount").textContent = `${P.length} jugador${P.length === 1 ? "" : "es"} · ${isHost() ? "pulsa Sortear equipos o Empezar ronda" : "el anfitrión sorteará los equipos"}`;
  $("#runCount").textContent = `${R.length} suelto${R.length === 1 ? "" : "s"}`;
  $("#huntCount").textContent = `${H.length} en caza`;

  const rounds = Object.values(G.rounds || {});
  $("#scoreR").textContent = rounds.filter(r => r.winner === "r").length;
  $("#scoreH").textContent = rounds.filter(r => r.winner === "h").length;
  const total = {};
  rounds.forEach(r => Object.values(r.catches || {}).forEach(c => { if (c.by) total[c.by] = (total[c.by] || 0) + 1; }));
  $("#stats").innerHTML = ids().sort((a, b) => (total[b] || 0) - (total[a] || 0)).map(id => `<tr><td>${esc(players()[id].name)}</td><td class="num">${total[id] || 0}</td></tr>`).join("");

  const entries = Object.values(G.log || {}).filter(l => l.round === G.round).reverse();
  $("#log").innerHTML = entries.length ? entries.map(l => `<li><time>${fmt(l.t)}</time><span><span class="tag ${l.kind}">${{c: "Captura", p: "Ping", i: "Info", z: "Zona"}[l.kind]}</span>${esc(l.text)}</span></li>`).join("")
    : `<li><time>—</time><span class="muted">Aquí saldrán las capturas de esta ronda.</span></li>`;

  const isH = isHost();
  $("#hostControls").hidden = !isH;
  $("#drawBtn").disabled = live || status() === "ended";
  $("#startBtn").textContent = status() === "paused" ? "Reanudar" : "Empezar ronda";
  $("#startBtn").disabled = status() === "running" || status() === "ended";
  $("#pauseBtn").disabled = status() !== "running";
  $("#endBtn").disabled = !live;
  for (const [id, key, , , scale] of FIELDS) {
    const el = $("#" + id); el.disabled = !isH || live;
    if (document.activeElement !== el) el.value = +(s[key] * scale).toFixed(1);
  }
  const role = roleOf(pid);
  $("#youAre").innerHTML = (role ? `Juegas como <span class="pill ${role}">${role === "runner" ? "corredor" : "cazador"}</span>` : `Esperando el sorteo de equipos.`)
    + (isH ? "" : ` <span class="muted">· El anfitrión (${esc(players()[G.host]?.name || "?")}) controla el reloj.</span>`);
  renderBanner(); renderGeoNotice(); renderZoneBar(); drawZone(); tick();
}

function tick() {
  if (!G) return;
  const s = settings(), total = s.durMin * 60000, head = s.headSec * 1000, e = elapsed(), st = status();
  const ph = $("#phase"); ph.className = "phase";
  let label, sub;
  if (st === "idle") { label = "Preparados"; sub = `Ventaja ${fmt(head)} · ping cada ${fmt(s.pingSec * 1000)}`; }
  else if (st === "ended") { label = "Ronda terminada"; sub = `Duró ${fmt(e)}`; }
  else if (e < head) { label = st === "paused" ? "En pausa" : "Ventaja: ¡corred!"; if (st === "running") ph.classList.add("head"); sub = `Los cazadores salen en ${fmt(head - e)}`; }
  else { label = st === "paused" ? "En pausa" : "Caza en marcha"; if (st === "running") ph.classList.add("live"); sub = `${runnerIds().length} sueltos · ${fmt(e)} transcurrido`; }
  $("#phaseText").textContent = label; $("#sub").textContent = sub;
  $("#time").textContent = fmtClock(st === "idle" ? total : total - e);
  $("#bar").style.width = `${Math.min(100, e / total * 100)}%`;

  const slot = pingSlot();
  $("#pingInfo").textContent = slot == null
    ? (isLive() && e < head ? `Primer ping en ${fmt(head - e)}` : "Los pings empiezan al acabar la ventaja")
    : `Próximo ping en ${fmt(s.pingSec * 1000 - ((e - head) % (s.pingSec * 1000)))}`;

  maybePing();
  drawPins();
  checkZone();
  document.querySelectorAll("#runList .pmeta").forEach((el, i) => {
    const id = runnerIds()[i], l = G.locs?.[id];
    if (isLive() && l && l.round === G.round) el.textContent = `último ping ${ago(l.t)}`;
  });

  // El anfitrión cierra la ronda al acabar el tiempo; si no está conectado, cualquiera lo hace poco después.
  if (st === "running" && e >= total + (isHost() ? 0 : 5000)) endRound("r", "Se acabó el tiempo. Ganan los corredores.");
}
setInterval(tick, 1000);

// ---------- Arranque ----------

$("#nameIn").value = load("manhunt-name") || "";
if (store.local) {
  const n = $("#modeNotice"); n.className = "notice";
  n.textContent = "Modo prueba: falta configurar Firebase, así que la partida solo se comparte entre pestañas de este navegador.";
}
const hashCode = location.hash.slice(1).toUpperCase();
const saved = load("manhunt-code");
if (/^[A-Z0-9]{5}$/.test(hashCode)) $("#codeIn").value = hashCode;
if (saved && (!hashCode || hashCode === saved)) {
  store.ready.then(() => store.get(`games/${saved}`)).then(g => { if (g?.players?.[pid]) enterGame(saved); else keep("manhunt-code", null); });
}
// ---------- Instalar como app ----------

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

const installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
let installEvent = null;
// Android y Chrome avisan cuando se puede instalar; entonces enseñamos el botón.
addEventListener("beforeinstallprompt", e => {
  e.preventDefault(); installEvent = e;
  const box = $("#installBox");
  box.innerHTML = `Instala Manhunt en el móvil para abrirla como una app. <button class="small" type="button" id="installBtn">Instalar app</button>`;
  box.hidden = false;
  $("#installBtn").onclick = async () => { installEvent.prompt(); await installEvent.userChoice; installEvent = null; box.hidden = true; };
});
// En iPhone no hay botón: se instala desde el menú Compartir de Safari.
if (isIOS && !installed) {
  $("#installBox").textContent = "Para instalarla como app: en Safari pulsa Compartir y luego “Añadir a pantalla de inicio”.";
  $("#installBox").hidden = false;
}

store.ready.catch(err =>joinError("No se pudo conectar con Firebase: " + err.message + ". Revisa que la autenticación anónima esté activada."));
