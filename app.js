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

/* Alte Versionen eines Produkts abrufen (mit Zwischenspeicher, alte Versionen ändern sich nie) */
async function getRev(code, rev){
  const cache = load("rev_" + code, {});
  if(cache[rev]) return cache[rev];
  const r = await fetch(`${OFF}/api/v2/product/${code}?rev=${rev}&fields=quantity,last_modified_t`);
  if(!r.ok) return null;
  const j = await r.json();
  if(!j.product) return null;
  const v = {q: j.product.quantity || null, t: j.product.last_modified_t || null};
  cache[rev] = v; save("rev_" + code, cache);
  return v;
}

/* Füllmengen-Verlauf: Stichproben über alle Versionen, dann genaue Suche, wo sich die Menge ändert */
async function quantityHistory(code, maxRev, onProgress){
  if(!maxRev || maxRev < 2) return [];
  const revs = {};
  let calls = 0; const LIMIT = 70;
  const fetchRev = async n => { if(revs[n] !== undefined) return revs[n]; if(calls >= LIMIT){ revs[n] = null; return null; } calls++; revs[n] = await getRev(code, n).catch(() => null); onProgress && onProgress(Math.min(calls / 30, 1)); return revs[n]; };

  const N = Math.min(16, maxRev);
  const sample = [...new Set(Array.from({length:N}, (_, i) => Math.round(1 + i * (maxRev - 1) / (N - 1))))];
  for(let i = 0; i < sample.length; i += 4) await Promise.all(sample.slice(i, i+4).map(fetchRev));

  for(let i = 0; i < sample.length - 1; i++){
    let a = sample[i], b = sample[i+1];
    if(!revs[a] || !revs[b]) continue;
    if(qtyKey(revs[a].q) === qtyKey(revs[b].q)) continue;
    while(b - a > 1 && calls < LIMIT){
      const mid = Math.floor((a + b) / 2);
      const v = await fetchRev(mid);
      if(!v) break;
      if(qtyKey(v.q) === qtyKey(revs[a].q)) a = mid; else b = mid;
    }
  }
  onProgress && onProgress(1);

  const list = Object.keys(revs).map(Number).sort((x,y) => x-y).filter(n => revs[n] && revs[n].q);
  const seg = [];
  for(const n of list){
    const k = qtyKey(revs[n].q);
    if(!seg.length || seg[seg.length-1].key !== k) seg.push({key:k, raw:revs[n].q, p:parseQty(revs[n].q), from:revs[n].t ? revs[n].t*1000 : null, rev:n});
  }
  return seg;
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

async function show(code){
  code = String(code).replace(/\D/g, "");
  if(code.length < 8 || code.length > 14){ $("#result").innerHTML = `<div class="card"><p>Bitte einen gültigen Barcode eingeben (8–14 Ziffern).</p></div>`; return; }
  $("#code").value = code;
  $("#result").innerHTML = `<div class="card"><p>Suche Produkt …</p></div>`;
  let p;
  try{ p = await getProduct(code); }
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
  const [seg, op] = await Promise.all([
    quantityHistory(code, Math.min(Math.max(parseInt(p.rev, 10) || 0, 0), 5000), f => { const b = $("#bar"); if(b) b.style.width = (f*100) + "%"; }).catch(() => []),
    getPrices(code)
  ]);
  window._seg = seg; window._opPrices = op;
  renderHistory(seg, p, cur);
  renderPrices(code, cur, seg, op);
}

function renderHistory(seg, p, cur){
  if(!seg.length){
    $("#hist").innerHTML = `<p>Füllmenge: <b>${esc(p.quantity || "unbekannt")}</b></p><p class="muted">Noch keine älteren Angaben in der Datenbank. Der Verlauf wächst, sobald das Produkt neu erfasst wird.</p>`;
    return;
  }
  let alerts = "";
  const items = seg.map((s, i) => {
    let badge = `<span class="badge b-gray">Start</span>`;
    if(i > 0){
      const prev = seg[i-1].p;
      if(prev && s.p && prev.unit === s.p.unit && prev.amount !== s.p.amount){
        const d = (s.p.amount - prev.amount) / prev.amount * 100;
        badge = `<span class="badge ${d < 0 ? "b-red" : "b-green"}">${fmtPct(d)}</span>`;
        if(d < 0){
          const hidden = (prev.amount / s.p.amount - 1) * 100;
          alerts += `<div class="alert">⚠️ <b>Weniger Inhalt:</b> von ${qtyText(prev)} auf ${qtyText(s.p)} (${fmtPct(d)})${s.from ? ", ab ca. " + fmtDate(s.from) : ""}.<br>Bei gleichem Preis ist das eine versteckte Preiserhöhung von <b>${fmtPct(hidden)}</b>.</div>`;
        }
      } else badge = `<span class="badge b-gray">geändert</span>`;
    }
    return `<li><span>${s.from ? fmtDate(s.from) : "?"}</span><span><b>${esc(s.raw)}</b> ${badge}</span></li>`;
  }).reverse().join("");
  $("#hist").innerHTML = (alerts || `<div class="ok">✅ Keine Verkleinerung gefunden.</div>`) +
    `<ul class="tl" style="margin-top:10px">${items}</ul>
     <p class="muted small">Datum = wann die Angabe in der Datenbank geändert wurde (nicht unbedingt der Tag der Änderung im Laden). Verlauf erst ab Aufnahme in die Datenbank.</p>`;
}

function renderPrices(code, cur, seg, op){
  const own = arr2(load("own_" + code, [])).map((x, i) => ({...x, own:true, idx:i})).filter(x => +x.price > 0 && isFinite(x.date));
  const all = [...own, ...op].sort((a,b) => b.date - a.date);
  if(!all.length){ $("#prices").innerHTML = `<p class="muted">Noch keine Preise bekannt. Trag den Preis aus dem Laden ein, dann entsteht dein eigener Verlauf.</p>`; return; }
  const rows = all.map(x => {
    const q = x.own && x.qty ? parseQty(x.qty) : qtyAt(seg, x.date, cur);
    x.gp = q ? x.price / q.amount * 1000 : null;
    x.unit = q ? (q.unit === "g" ? "kg" : "l") : "";
    return `<tr><td>${fmtDate(x.date)}<div class="muted small">${esc(x.shop)}${x.own ? " · du" : ""}</div></td>
      <td class="r"><b>${fmtEur(x.price)}</b></td>
      <td class="r">${x.gp ? fmtEur(x.gp) + "/" + x.unit : "–"}</td>
      <td class="r">${x.own ? `<button class="sec" style="padding:4px 8px" data-del="${x.idx}">✕</button>` : ""}</td></tr>`;
  }).join("");
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
