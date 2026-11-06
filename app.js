"use strict";
const OFF = "https://world.openfoodfacts.org";
const PRICES = "https://prices.openfoodfacts.org/api/v1";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate = t => new Date(t).toLocaleDateString("de-DE", {day:"2-digit", month:"2-digit", year:"numeric"});
const fmtEur = n => n.toLocaleString("de-DE", {style:"currency", currency:"EUR"});
const fmtPct = n => (n > 0 ? "+" : "") + n.toLocaleString("de-DE", {maximumFractionDigits:1}) + " %";

/* ---------- Speicher (nur dieses Gerät) ---------- */
function load(key, def){ try{ return JSON.parse(localStorage.getItem(key)) ?? def; }catch(e){ return def; } }
function save(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ try{ Object.keys(localStorage).filter(k => k.startsWith("rev_")).forEach(k => localStorage.removeItem(k)); localStorage.setItem(key, JSON.stringify(val)); }catch(e2){} } }

/* ---------- Füllmenge lesen: "4 x 125 g", "1,5 l", "500g" ---------- */
function parseQty(str){
  if(!str) return null;
  const s = String(str).toLowerCase().replace(/,/g, ".");
  const units = {kg:[1000,"g"], g:[1,"g"], mg:[0.001,"g"], l:[1000,"ml"], cl:[10,"ml"], ml:[1,"ml"]};
  let m = s.match(/(\d+)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(kg|mg|g|cl|ml|l)\b/);
  if(m){ const a = +m[1] * +m[2] * units[m[3]][0]; return a > 0 && isFinite(a) ? {amount:a, unit:units[m[3]][1]} : null; }
  m = s.match(/(\d+(?:\.\d+)?)\s*(kg|mg|g|cl|ml|l)\b/);
  if(m){ const a = +m[1] * units[m[2]][0]; return a > 0 && isFinite(a) ? {amount:a, unit:units[m[2]][1]} : null; }
  return null;
}
const qtyKey = q => { const p = parseQty(q); return p ? Math.round(p.amount*10)/10 + p.unit : (q ? String(q).trim().toLowerCase().replace(/\s+/g,"") : null); };
const qtyText = p => p ? (p.amount >= 1000 ? (p.amount/1000).toLocaleString("de-DE") + (p.unit === "g" ? " kg" : " l") : p.amount.toLocaleString("de-DE") + " " + p.unit) : "?";

/* ---------- Open Food Facts ---------- */
const FIELDS = "code,product_name,product_name_de,brands,quantity,image_front_small_url,image_front_url,ingredients_text_de,ingredients_text,nutriments,nutriscore_grade,allergens_tags,additives_tags,rev,created_t,last_modified_t";

async function getProduct(code){
  const r = await fetch(`${OFF}/api/v2/product/${code}?fields=${FIELDS}`);
  if(!r.ok && r.status !== 404) throw new Error("Datenbank nicht erreichbar (" + r.status + ")");
  const j = await r.json();
  return j.status === 1 ? j.product : null;
}

/* Alte Versionen eines Produkts abrufen (mit Zwischenspeicher, alte Versionen ändern sich nie).
   Bei Fehlern (Datenbank ausgelastet) bis zu 3 Versuche mit Pause. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getRev(code, rev){
  const cache = load("rev_" + code, {});
  if(cache && cache[rev]) return cache[rev];
  for(let attempt = 1; attempt <= 3; attempt++){
    try{
      const r = await fetch(`${OFF}/api/v2/product/${code}?rev=${rev}&fields=quantity,last_modified_t`);
      if(r.status === 404){ const v = {q:null, t:null}; cache[rev] = v; save("rev_" + code, cache); return v; }
      if(r.ok){
        const j = await r.json();
        const v = {q: j.product?.quantity || null, t: j.product?.last_modified_t || null};
        const c2 = load("rev_" + code, {}) || {}; c2[rev] = v; save("rev_" + code, c2);
        return v;
      }
    }catch(e){}
    await sleep(900 * attempt);
  }
  return null; // endgültig fehlgeschlagen, wird NICHT gespeichert
}

/* Nur echte Mengen mit Einheit zählen ("185 g", "1,5 l"). Einträge wie "185", "2pcs" sind Tippfehler in der Datenbank. */
const goodKey = q => { const p = parseQty(q); return p ? Math.round(p.amount*10)/10 + p.unit : null; };

const HIST_VER = 2;
async function quantityHistory(code, p, onProgress){
  const maxRev = Math.min(Math.max(parseInt(p.rev, 10) || 0, 0), 5000);
  if(maxRev < 2) return {seg:[], complete:true};
  const saved = load("hist_" + code, null);
  if(saved && saved.v === HIST_VER && saved.maxRev === maxRev) return saved.res;

  const revs = {}; let failed = 0, done = 0;
  revs[maxRev] = {q: p.quantity || null, t: p.last_modified_t || null};
  const want = new Set();
  const fetchRev = async n => {
    if(revs[n] !== undefined) return revs[n];
    revs[n] = await getRev(code, n);
    if(revs[n] === null) failed++;
    done++; onProgress && onProgress(Math.min(done / Math.max(want.size, 1), 1));
    return revs[n];
  };
  const runAll = async list => { for(let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i+3).map(fetchRev)); };

  if(maxRev <= 80){
    // Wenige Versionen: alle abrufen -> vollständig und immer gleich
    const list = []; for(let n = 1; n < maxRev; n++){ list.push(n); want.add(n); }
    await runAll(list);
  } else {
    // Viele Versionen: 40 Stichproben, dann genaue Suche zwischen unterschiedlichen Mengen
    const N = 40;
    const sample = [...new Set(Array.from({length:N}, (_, i) => Math.round(1 + i * (maxRev - 1) / (N - 1))))];
    sample.forEach(n => want.add(n));
    await runAll(sample);
    const known = sample.filter(n => revs[n] && goodKey(revs[n].q));
    for(let i = 0; i < known.length - 1; i++){
      let a = known[i], b = known[i+1];
      if(goodKey(revs[a].q) === goodKey(revs[b].q)) continue;
      let guard = 0;
      while(b - a > 1 && guard++ < 20){
        const mid = Math.floor((a + b) / 2); want.add(mid);
        const v = await fetchRev(mid);
        const k = v ? goodKey(v.q) : null;
        if(k === null){ a = mid; continue; }          // unbrauchbarer Eintrag: weiter eingrenzen
        if(k === goodKey(revs[a].q)) a = mid; else b = mid;
      }
    }
  }
  onProgress && onProgress(1);

  const list = Object.keys(revs).map(Number).sort((x,y) => x-y).filter(n => revs[n] && goodKey(revs[n].q));
  const seg = [];
  for(const n of list){
    const k = goodKey(revs[n].q);
    if(!seg.length || seg[seg.length-1].key !== k) seg.push({key:k, p:parseQty(revs[n].q), from:revs[n].t ? revs[n].t*1000 : null, rev:n});
  }
  const res = {seg, complete: failed === 0};
  if(res.complete) save("hist_" + code, {v:HIST_VER, maxRev, res});
  return res;
}

/* ---------- Open Prices ---------- */
async function getPrices(code){
  try{
    const r = await fetch(`${PRICES}/prices?product_code=${code}&order_by=-date&size=100`);
    if(!r.ok) return [];
    const j = await r.json();
    return (j.items || []).filter(x => x && x.currency === "EUR" && +x.price > 0 && +x.price < 10000 && !isNaN(new Date(x.date))).map(x => ({
      date: new Date(x.date).getTime(), price: +x.price, shop: [x.location?.osm_name, x.location?.osm_address_city].filter(Boolean).join(", ") || "Open Prices", own:false
    }));
  }catch(e){ return []; }
}

/* ---------- Anzeige ---------- */
const ALLERGENE = {"milk":"Milch","gluten":"Gluten","nuts":"Schalenfrüchte","peanuts":"Erdnüsse","soybeans":"Soja","eggs":"Eier","fish":"Fisch","crustaceans":"Krebstiere","celery":"Sellerie","mustard":"Senf","sesame-seeds":"Sesam","sulphur-dioxide-and-sulphites":"Sulfite","lupin":"Lupinen","molluscs":"Weichtiere"};
const NS_COL = {a:"#038141", b:"#85bb2f", c:"#fecb02", d:"#ee8100", e:"#e63e11"};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const safeImg = u => (typeof u === "string" && /^https:\/\/(images|static)\.openfoodfacts\.org\//.test(u)) ? u : null;
const arr2 = a => Array.isArray(a) ? a : [];
const arr = a => Array.isArray(a) ? a.filter(x => typeof x === "string").slice(0, 40) : [];
const tagName = t => String(t || "").split(":").pop();

function qtyAt(seg, date, fallback){
  let q = fallback;
  for(const s of seg){ if(s.from && s.from <= date) q = s.p; }
  if(seg.length && date < (seg[0].from || 0)) q = seg[0].p;
  return q;
}

let showToken = 0;
async function show(code){
  const my = ++showToken;
  code = String(code).replace(/\D/g, "");
  if(code.length < 8 || code.length > 14){ $("#result").innerHTML = `<div class="card"><p>Bitte einen gültigen Barcode eingeben (8–14 Ziffern).</p></div>`; return; }
  $("#code").value = code;
  $("#result").innerHTML = `<div class="card"><p>Suche Produkt …</p></div>`;
  let p;
  try{ p = await getProduct(code); if(my !== showToken) return; }
  catch(e){ $("#result").innerHTML = `<div class="card"><p>⚠️ ${esc(e.message)}</p></div>`; return; }
  if(!p){
    $("#result").innerHTML = `<div class="card"><h2>Nicht gefunden</h2><p>Der Barcode <b>${esc(code)}</b> ist noch nicht in der Datenbank.</p>
      <p class="muted">Du kannst das Produkt in der Open-Food-Facts-App mit Fotos eintragen. Danach erscheint es auch hier.</p></div>`;
    return;
  }
  const name = String(p.product_name_de || p.product_name || "Unbekanntes Produkt").slice(0, 150);
  addRecent(code, name);
  const cur = parseQty(p.quantity);
  const img = safeImg(p.image_front_small_url) || safeImg(p.image_front_url);
  const ns0 = String(p.nutriscore_grade || "").toLowerCase();
  const ns = has(NS_COL, ns0) ? ns0 : "";

  $("#result").innerHTML = `
  <section class="card">
    <div class="prod">
      ${img ? `<img src="${esc(img)}" alt="">` : ""}
      <div>
        <h3>${esc(name)}</h3>
        <div class="muted">${esc(p.brands || "")}</div>
        <div style="margin-top:6px">Füllmenge jetzt: <b>${esc(p.quantity || "unbekannt")}</b></div>
        ${ns ? `<div style="margin-top:6px">Nutri-Score <span class="ns" style="background:${NS_COL[ns]}">${ns.toUpperCase()}</span></div>` : ""}
        <div style="margin-top:8px"><button id="btnShare" class="sec" style="padding:8px 12px">📤 Teilen</button> <span id="shareMsg" class="muted small"></span></div>
        <div class="muted small">In der Datenbank seit ${p.created_t ? fmtDate(p.created_t*1000) : "?"}</div>
      </div>
    </div>
  </section>
  <section class="card"><h2>📦 Füllmengen-Verlauf</h2><div id="hist"><p class="muted">Lade alte Versionen …</p><div class="progress"><div id="bar"></div></div></div></section>
  <section class="card"><h2>💶 Preise</h2><div id="prices"><p class="muted">Lade Preise …</p></div>
    <div style="margin-top:12px">
      <div class="muted small" style="margin-bottom:6px">Preis aus dem Laden eintragen:</div>
      <div class="row"><input id="pPrice" inputmode="decimal" placeholder="Preis, z. B. 2,49"><input id="pShop" placeholder="Laden, z. B. Rewe"></div>
      <div class="row" style="margin-top:8px"><input id="pDate" type="date"><button id="pSave">Speichern</button></div>
    </div>
  </section>
  <section class="card"><h2>🧾 Zutaten</h2>
    <p>${esc(p.ingredients_text_de || p.ingredients_text || "Keine Zutatenliste vorhanden.")}</p>
    ${arr(p.allergens_tags).length ? `<div class="muted small">Allergene:</div><div>${arr(p.allergens_tags).map(a => `<span class="tag">${esc(has(ALLERGENE, tagName(a)) ? ALLERGENE[tagName(a)] : tagName(a))}</span>`).join("")}</div>` : ""}
    ${arr(p.additives_tags).length ? `<div class="muted small" style="margin-top:8px">Zusatzstoffe:</div><div>${arr(p.additives_tags).map(a => `<span class="tag">${esc(tagName(a).toUpperCase())}</span>`).join("")}</div>` : ""}
  </section>
  <section class="card"><h2>📊 Nährwerte pro 100 g / ml</h2>${nutriTable(p.nutriments || {})}</section>
  <section class="card"><p class="muted small">Mogelpackung entdeckt? Du kannst sie bei der <a href="https://www.vzhh.de" target="_blank" rel="noopener">Verbraucherzentrale Hamburg</a> melden.</p></section>`;

  $("#btnShare").onclick = () => shareProduct(code, name, p);
  try{ history.replaceState(null, "", "#" + code); }catch(e){}
  $("#pDate").value = new Date().toISOString().slice(0,10);
  $("#pSave").onclick = () => {
    const price = parseFloat(($("#pPrice").value || "").replace(",", "."));
    if(!(price > 0 && price < 10000)){ $("#pPrice").focus(); return; }
    const own = arr2(load("own_" + code, []));
    if(own.length >= 500) own.shift();
    own.push({date: new Date($("#pDate").value).getTime() || Date.now(), price, shop: $("#pShop").value.trim().slice(0, 60) || "Eigener Eintrag", qty: p.quantity || null});
    save("own_" + code, own);
    $("#pPrice").value = "";
    renderPrices(code, cur, window._seg || [], window._opPrices || []);
  };

  window._seg = [];
  const [h, op] = await Promise.all([
    quantityHistory(code, p, f => { const b = $("#bar"); if(b) b.style.width = (f*100) + "%"; }).catch(() => ({seg:[], complete:false})),
    getPrices(code)
  ]);
  if(my !== showToken) return;
  const seg = h.seg; window._seg = seg; window._opPrices = op;
  renderHistory(h, p, cur);
  renderPrices(code, cur, seg, op);
}

function renderHistory(h, p, cur){
  const seg = h.seg;
  window._share = null;
  const warnIncomplete = h.complete ? "" : `<p class="muted small">⏳ Ein paar alte Versionen konnten gerade nicht geladen werden (Datenbank ausgelastet). Bitte später nochmal suchen.</p>`;
  if(!seg.length){
    $("#hist").innerHTML = `<p>Füllmenge: <b>${esc(p.quantity || "unbekannt")}</b></p><p class="muted">Noch keine älteren Angaben in der Datenbank. Der Verlauf wächst, sobald das Produkt neu erfasst wird.</p>` + warnIncomplete;
    return;
  }
  const first = seg[0].p, last = seg[seg.length-1].p;
  const same = (x, y) => x && y && x.unit === y.unit;
  const anyDrop = seg.some((s, i) => i > 0 && same(seg[i-1].p, s.p) && s.p.amount < seg[i-1].p.amount);
  let box;
  if(same(first, last) && last.amount < first.amount){
    const d = (last.amount - first.amount) / first.amount * 100;
    const hidden = (first.amount / last.amount - 1) * 100;
    const when = [...seg].reverse().find(s => s.p.amount === last.amount);
    box = `<div class="alert">⚠️ <b>Weniger Inhalt:</b> von ${qtyText(first)} auf ${qtyText(last)} (${fmtPct(d)})${when && when.from ? ", seit ca. " + fmtDate(when.from) : ""}.<br>Bei gleichem Preis ist das eine versteckte Preiserhöhung von <b>${fmtPct(hidden)}</b>.</div>`;
    window._share = `Füllmenge von ${qtyText(first)} auf ${qtyText(last)} geschrumpft (${fmtPct(d)}). Bei gleichem Preis = ${fmtPct(hidden)} teurer!`;
  } else if(anyDrop){
    const low = seg.filter(s => same(s.p, last)).reduce((m, s) => s.p.amount < m.p.amount ? s : m);
    box = `<div class="alert" style="border-left-color:var(--yellow);background:rgba(250,204,21,.08)">🤔 <b>Unklar:</b> Zwischendurch war ${qtyText(low.p)} eingetragen, jetzt wieder ${qtyText(last)}. Das kann ein Eingabefehler in der Datenbank sein oder eine Sondergröße (z. B. Aktionsdose). Am besten im Laden auf der Packung nachsehen.</div>`;
    window._share = `Füllmenge aktuell ${qtyText(last)} (zwischendurch ${qtyText(low.p)} eingetragen).`;
  } else {
    box = `<div class="ok">✅ Keine Verkleinerung gefunden.</div>`;
    window._share = `Füllmenge ${qtyText(last)}, keine Verkleinerung gefunden.`;
  }
  const items = seg.map((s, i) => {
    let badge = `<span class="badge b-gray">Start</span>`;
    if(i > 0){
      const prev = seg[i-1].p;
      if(same(prev, s.p)){
        const d = (s.p.amount - prev.amount) / prev.amount * 100;
        badge = `<span class="badge ${d < 0 ? "b-red" : "b-green"}">${fmtPct(d)}</span>`;
      } else badge = `<span class="badge b-gray">geändert</span>`;
    }
    return `<li><span>${s.from ? fmtDate(s.from) : "?"}</span><span><b>${esc(qtyText(s.p))}</b> ${badge}</span></li>`;
  }).reverse().join("");
  $("#hist").innerHTML = box + `<ul class="tl" style="margin-top:10px">${items}</ul>` + warnIncomplete +
    `<p class="muted small">Datum = wann die Angabe in der Datenbank geändert wurde (nicht unbedingt der Tag der Änderung im Laden). Verlauf erst ab Aufnahme in die Datenbank. Einträge ohne Einheit (z. B. „185“ oder „2pcs“) werden als Tippfehler ignoriert.</p>`;
}

function renderPrices(code, cur, seg, op){
  const own = arr2(load("own_" + code, [])).map((x, i) => ({...x, own:true, idx:i})).filter(x => +x.price > 0 && isFinite(x.date));
  const all = [...own, ...op].sort((a,b) => b.date - a.date);
  if(!all.length){ window._lastPrice = null; $("#prices").innerHTML = `<p class="muted">Noch keine Preise bekannt. Trag den Preis aus dem Laden ein, dann entsteht dein eigener Verlauf.</p>`; return; }
  const rows = all.map(x => {
    const q = x.own && x.qty ? parseQty(x.qty) : qtyAt(seg, x.date, cur);
    x.gp = q ? x.price / q.amount * 1000 : null;
    x.unit = q ? (q.unit === "g" ? "kg" : "l") : "";
    return `<tr><td>${fmtDate(x.date)}<div class="muted small">${esc(x.shop)}${x.own ? " · du" : ""}</div></td>
      <td class="r"><b>${fmtEur(x.price)}</b></td>
      <td class="r">${x.gp ? fmtEur(x.gp) + "/" + x.unit : "–"}</td>
      <td class="r">${x.own ? `<button class="sec" style="padding:4px 8px" data-del="${x.idx}">✕</button>` : ""}</td></tr>`;
  }).join("");
  window._lastPrice = all[0] || null;
  let summary = "";
  const withGp = all.filter(x => x.gp);
  if(withGp.length >= 2){
    const oldest = withGp[withGp.length-1], newest = withGp[0];
    const d = (newest.gp - oldest.gp) / oldest.gp * 100;
    summary = `<div class="${d > 0 ? "alert" : "ok"}" style="margin-bottom:10px">Grundpreis ${fmtDate(oldest.date)} → ${fmtDate(newest.date)}: <b>${fmtEur(oldest.gp)} → ${fmtEur(newest.gp)}</b> pro ${newest.unit} (${fmtPct(d)})</div>`;
  }
  $("#prices").innerHTML = summary + `<table><tr><th>Datum</th><th class="r">Preis</th><th class="r">Grundpreis</th><th></th></tr>${rows}</table>`;
  $("#prices").querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    const own = arr2(load("own_" + code, [])); own.splice(+b.dataset.del, 1); save("own_" + code, own);
    renderPrices(code, cur, seg, op);
  });
}

function nutriTable(n){
  const rows = [["Energie","energy-kcal_100g","kcal"],["Fett","fat_100g","g"],["davon gesättigte Fettsäuren","saturated-fat_100g","g"],["Kohlenhydrate","carbohydrates_100g","g"],["davon Zucker","sugars_100g","g"],["Ballaststoffe","fiber_100g","g"],["Eiweiß","proteins_100g","g"],["Salz","salt_100g","g"]]
    .filter(r => n[r[1]] !== undefined && n[r[1]] !== "")
    .map(r => `<tr><td>${r[0]}</td><td class="r">${(+n[r[1]]).toLocaleString("de-DE",{maximumFractionDigits:1})} ${r[2]}</td></tr>`).join("");
  return rows ? `<table>${rows}</table>` : `<p class="muted">Keine Nährwerte vorhanden.</p>`;
}

/* ---------- Teilen (WhatsApp, E-Mail usw. über das Teilen-Menü des Handys) ---------- */
async function shareProduct(code, name, p){
  const url = location.origin + location.pathname + "#" + code;
  const lines = [`🔍 ${name}${p.brands ? " (" + String(p.brands).slice(0, 60) + ")" : ""}`];
  if(window._share) lines.push(window._share);
  const pr = window._lastPrice;
  if(pr) lines.push(`Letzter Preis: ${fmtEur(pr.price)}${pr.gp ? " (" + fmtEur(pr.gp) + "/" + pr.unit + ")" : ""}`);
  const text = lines.join("\n");
  const msg = $("#shareMsg");
  if(navigator.share){
    try{ await navigator.share({title: "Mogel-Check: " + name, text, url}); return; }
    catch(e){ if(e && e.name === "AbortError") return; }
  }
  try{ await navigator.clipboard.writeText(text + "\n" + url); msg.textContent = "In die Zwischenablage kopiert."; }
  catch(e){ msg.innerHTML = `<a href="https://wa.me/?text=${encodeURIComponent(text + "\n" + url)}" target="_blank" rel="noopener">Per WhatsApp senden</a>`; }
}

/* ---------- Zuletzt angesehen ---------- */
function addRecent(code, name){
  let r = arr2(load("recent", [])).filter(x => x && x.code !== code);
  r.unshift({code, name}); r = r.slice(0, 15); save("recent", r); renderRecent();
}
function renderRecent(){
  const r = arr2(load("recent", [])).filter(x => x && /^\d{8,14}$/.test(x.code));
  if(!r.length) return;
  $("#recent").innerHTML = r.map(x => `<button data-code="${esc(x.code)}">${esc(x.name)} <span class="muted small">· ${esc(x.code)}</span></button>`).join("");
  $("#recent").querySelectorAll("button").forEach(b => b.onclick = () => { show(b.dataset.code); window.scrollTo({top:0, behavior:"smooth"}); });
}

/* ---------- Scanner ---------- */
let scanner = null, scanning = false;
async function toggleScan(){
  if(scanning){ await stopScan(); return; }
  if(typeof Html5Qrcode === "undefined"){ $("#scanMsg").textContent = "Scanner konnte nicht geladen werden. Bitte Barcode eintippen."; return; }
  $("#reader").classList.remove("hidden");
  $("#scanMsg").textContent = "Halte den Barcode in den Rahmen …";
  const F = Html5QrcodeSupportedFormats;
  scanner = scanner || new Html5Qrcode("reader", {formatsToSupport:[F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E], verbose:false, experimentalFeatures:{useBarCodeDetectorIfSupported:true}});
  try{
    await scanner.start({facingMode:"environment"}, {fps:10, qrbox:{width:260, height:140}}, async text => { await stopScan(); show(text); });
    scanning = true; $("#btnScan").textContent = "⏹ Scannen beenden";
  }catch(e){
    $("#reader").classList.add("hidden");
    $("#scanMsg").textContent = "Kein Kamerazugriff. Bitte die Kamera erlauben oder den Barcode eintippen.";
  }
}
async function stopScan(){
  try{ if(scanner && scanning) await scanner.stop(); }catch(e){}
  scanning = false; $("#reader").classList.add("hidden"); $("#btnScan").textContent = "📷 Barcode scannen"; $("#scanMsg").textContent = "";
}

$("#btnScan").onclick = toggleScan;
$("#btnSearch").onclick = () => show($("#code").value);
$("#code").addEventListener("keydown", e => { if(e.key === "Enter") show($("#code").value); });
renderRecent();
const openHash = () => { const m = location.hash.match(/^#(\d{8,14})$/); if(m && m[1] !== $("#code").value) show(m[1]); };
window.addEventListener("hashchange", openHash);
openHash();
