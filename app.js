/* =====================================================================
   CAD PE — Dashboard de Ocupação de Armazenagem (Shopee Fulfillment)
   Versão clean. Fonte: Apps Script Web App (formato compacto headers+rows).
   ÚNICO ajuste manual: APPS_SCRIPT_URL.
   ===================================================================== */

const CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzrWzhMFTBJ6pGiZCh85gwozW2Tfy3kRdxeYabMYSliKv9B-VtOEp70wQvySh_YjuQ/exec",      // cole a URL /exec do Web App (uma vez)
  AUTO_REFRESH_MINUTES: 5
};

/* Capacidade por endereço (peças). Bin = 15, Pallet (HS) = 12 */
const CAPACITY = { A2: 15, HV: 15, BL: 15, M2: 15, HS: 12 };
const PICKING_FAMILIES = ["A2", "HS", "HV", "BL", "M2"];

/* Classe macro (rótulo das zonas não-picking) */
const ZONE_CLASS = {
  AV: "AV", MI: "Inbound", MTU: "Inbound", OS: "Outbound", MO: "Outbound",
  D: "Buffer", DEM: "Damage", RTS: "Returns", RO: "Virtual", TS: "Virtual"
};

const HEAT_SCALE = [
  { max: 40, color: "#16a34a", label: "0–40%" },
  { max: 70, color: "#f5b50a", label: "40–70%" },
  { max: 90, color: "#f97316", label: "70–90%" },
  { max: 110, color: "#e11d48", label: "90–110%" },
  { max: Infinity, color: "#9f1239", label: "110%+" }
];
const colorFor = pct => (HEAT_SCALE.find(s => pct < s.max) || HEAT_SCALE.at(-1)).color;

const STATE = { raw: [], filtered: [], zones: new Set(), charts: {}, refreshTimer: null };

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const fmtInt = n => Math.round(n || 0).toLocaleString("pt-BR");
const fmtNum = (n, d = 1) => (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pctTxt = n => `${fmtNum(n, 1)}%`;
const num = v => { if (typeof v === "number") return v; const n = parseFloat(String(v ?? "").replace(/\./g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const numDot = v => { if (typeof v === "number") return v; const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : 0; };
function setLoader(show, msg) { const el = $("#loader"); if (msg) $("#loaderMsg").textContent = msg; el.classList.toggle("hide", !show); }

function familyOf(zoneRaw, locId) {
  const z = String(zoneRaw || "").toUpperCase().trim();
  if (z.startsWith("HS")) return "HS";
  if (["A2", "HV", "BL", "M2", "AV"].includes(z)) return z;
  const p1 = String(locId || "").toUpperCase().split("-")[1] || "";
  if (p1.startsWith("HS")) return "HS";
  if (["A2", "HV", "BL", "M2", "AV"].includes(p1)) return p1;
  return z || p1 || "OUTROS";
}
function streetOf(family, zoneRaw, locId) {
  const parts = String(locId || "").toUpperCase().split("-");
  if (family === "HS") {
    const z = String(zoneRaw || "").toUpperCase().trim();
    if (z.startsWith("HS")) return z;
    return (parts[1] || "HS").replace(/[^A-Z0-9]/g, "");
  }
  const n = parts[2];
  return n != null ? String(parseInt(n, 10) || n).padStart(2, "0") : "—";
}
/* Ordenação: numéricas (01,02..) primeiro; HS depois, por número (HS2,HS3..HS24) */
function streetSortKey(st) {
  const s = String(st);
  if (/^\d+$/.test(s)) return [0, parseInt(s, 10), s];
  const m = s.match(/^HS(\d+)/i);
  if (m) return [1, parseInt(m[1], 10), s];
  return [2, 0, s];
}
function cmpStreet(a, b) {
  const ka = streetSortKey(a), kb = streetSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
}

/* =====================================================================
   1) CARREGAMENTO — Apps Script Web App (compacto: {headers, rows:[[...]]})
   ===================================================================== */
async function loadData() {
  const url = (CONFIG.APPS_SCRIPT_URL || "").trim();
  if (url) {
    try {
      setLoader(true, "Conectando ao Web App…");
      const data = await fetchAppsScript(url);
      STATE.raw = buildRecords(data);
      $("#footStatus").textContent = `Fonte: Apps Script · ${fmtInt(STATE.raw.length)} linhas · ${fmtInt(STATE.raw.reduce((s, r) => s + r.qty, 0))} peças`;
      if (STATE.raw.length) return;
      $("#footStatus").textContent = "⚠ Web App sem registros — verifique a aba Base";
    } catch (e) {
      console.error("Falha no Web App:", e);
      $("#footStatus").textContent = "⚠ Web App indisponível — exibindo demonstração";
    }
  } else {
    $("#footStatus").textContent = "Modo demonstração — cole a URL em CONFIG.APPS_SCRIPT_URL";
  }
  setLoader(true, "Gerando base de demonstração…");
  STATE.raw = buildDemoData();
}

async function fetchAppsScript(url) {
  const sep = url.includes("?") ? "&" : "?";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000); // 90s de teto
  try {
    console.time("[dash] fetch Web App");
    const res = await fetch(`${url}${sep}t=${Date.now()}`, { method: "GET", redirect: "follow", signal: ctrl.signal });
    console.timeEnd("[dash] fetch Web App");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.ok === false) throw new Error(data.error || "Erro no Web App");
    console.log("[dash] linhas recebidas:", (data.rows || []).length);
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Tempo esgotado (90s) — Web App não respondeu");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* Constrói registros enxutos a partir do formato compacto OU de array de objetos. */
function buildRecords(data) {
  // compacto: {headers:[...], rows:[[...]]}
  if (data && Array.isArray(data.headers) && Array.isArray(data.rows)) {
    const idx = {};
    data.headers.forEach((h, i) => idx[String(h).toLowerCase().trim()] = i);
    const find = keys => { for (const k of keys) { const i = idx[k.toLowerCase()]; if (i != null) return i; } return -1; };
    const c = {
      loc: find(["Location ID", "LocationID", "Location"]),
      zone: find(["Zone"]),
      qty: find(["Qty", "Quantidade"]),
      skuId: find(["SKU ID", "SKUID", "SKU"]),
      skuName: find(["SKU Name", "SKUName", "Nome"])
    };
    const at = (row, i) => i >= 0 ? row[i] : "";
    return data.rows.map(row => makeRecord({
      loc: at(row, c.loc), zone: at(row, c.zone), qty: at(row, c.qty),
      skuId: at(row, c.skuId), skuName: at(row, c.skuName)
    }));
  }
  // fallback: array de objetos (rows:[{...}])
  const arr = Array.isArray(data) ? data : (data.rows || []);
  return arr.map(o => {
    const g = (...keys) => { for (const k of keys) { const f = Object.keys(o).find(x => x.toLowerCase().trim() === k.toLowerCase()); if (f != null && o[f] !== "") return o[f]; } return ""; };
    return makeRecord({
      loc: g("Location ID", "LocationID"), zone: g("Zone"), qty: g("Qty"),
      skuId: g("SKU ID", "SKU"), skuName: g("SKU Name")
    });
  });
}

function makeRecord(f) {
  const locId = String(f.loc || "");
  const family = familyOf(f.zone, locId);
  return {
    family, locId, street: streetOf(family, f.zone, locId),
    skuId: String(f.skuId || ""), skuName: String(f.skuName || ""),
    qty: numDot(f.qty)
  };
}

/* =====================================================================
   2) AGREGAÇÃO
   ===================================================================== */
function aggregate(rows) {
  const A = { totalQty: 0, skuSet: new Set(), locSet: new Set(), families: {}, streets: {}, skuQty: {} };
  for (const r of rows) {
    A.totalQty += r.qty;
    if (r.skuId) A.skuSet.add(r.skuId);
    if (r.locId) A.locSet.add(r.locId);

    const f = A.families[r.family] || (A.families[r.family] = { qty: 0, skuSet: new Set(), locSet: new Set() });
    f.qty += r.qty;
    if (r.skuId) f.skuSet.add(r.skuId);
    if (r.locId) f.locSet.add(r.locId);

    if (PICKING_FAMILIES.includes(r.family)) {
      const sk = `${r.family}|${r.street}`;
      const s = A.streets[sk] || (A.streets[sk] = { family: r.family, street: r.street, qty: 0, skuSet: new Set(), locSet: new Set() });
      s.qty += r.qty;
      if (r.skuId) s.skuSet.add(r.skuId);
      if (r.locId) s.locSet.add(r.locId);
    }
    if (r.skuId) {
      const sq = A.skuQty[r.skuId] || (A.skuQty[r.skuId] = { id: r.skuId, name: r.skuName, qty: 0 });
      sq.qty += r.qty; if (!sq.name && r.skuName) sq.name = r.skuName;
    }
  }
  return A;
}

function streetCapacity(s) {
  const perAddr = CAPACITY[s.family] ?? 15;
  const cap = s.locSet.size * perAddr;
  return { addresses: s.locSet.size, perAddr, cap, occ: cap > 0 ? (s.qty / cap) * 100 : 0 };
}
function familyCapacity(f, key) {
  const perAddr = CAPACITY[key] ?? 15;
  const cap = f.locSet.size * perAddr;
  return { addresses: f.locSet.size, perAddr, cap, free: Math.max(0, cap - f.qty), occ: cap > 0 ? (f.qty / cap) * 100 : 0 };
}
function pickingOcc(A) {
  let qty = 0, cap = 0;
  for (const fam of PICKING_FAMILIES) { const f = A.families[fam]; if (!f) continue; qty += f.qty; cap += familyCapacity(f, fam).cap; }
  return cap > 0 ? (qty / cap) * 100 : 0;
}

/* =====================================================================
   3) RENDER
   ===================================================================== */
function renderAll() {
  const A = aggregate(STATE.filtered);
  renderKPIs(A);
  renderSaturation(A);
  renderNonPicking(A);
  renderHeatmap(A);
  renderZoneCards(A);
  renderCapacity(A);
  renderDistro(A);
  renderTopStreets(A);
  renderTopSku(A);
}

function renderKPIs(A) {
  const cards = [
    { lbl: "Total de Peças", val: fmtInt(A.totalQty), sub: "estoque total · Σ Qty", ico: "bi-boxes" },
    { lbl: "SKUs Ativos", val: fmtInt(A.skuSet.size), sub: "SKU ID distintos", ico: "bi-upc-scan" },
    { lbl: "Endereços", val: fmtInt(A.locSet.size), sub: "Location ID distintos", ico: "bi-geo-alt-fill" },
    { lbl: "Ocupação Picking", val: pctTxt(pickingOcc(A)), sub: "peças ÷ capacidade", ico: "bi-bezier2" }
  ];
  $("#kpiGrid").innerHTML = cards.map(c => `
    <div class="kpi"><i class="bi ${c.ico} kpi-ico"></i>
      <div class="kpi-label">${c.lbl}</div><div class="kpi-value">${c.val}</div><div class="kpi-sub">${c.sub}</div></div>`).join("");
}

function renderSaturation(A) {
  const occ = pickingOcc(A); const pill = $("#saturationPill");
  let cls, txt;
  if (occ >= 90) { cls = "crit"; txt = "🔴 Crítico"; }
  else if (occ >= 75) { cls = "warn"; txt = "🟡 Atenção"; }
  else { cls = "ok"; txt = "🟢 Saudável"; }
  pill.className = `saturation-pill ${cls}`;
  pill.querySelector(".label").textContent = `${txt} · Picking ${pctTxt(occ)}`;
}

function renderNonPicking(A) {
  const fams = Object.keys(A.families).filter(f => !PICKING_FAMILIES.includes(f))
    .sort((a, b) => A.families[b].qty - A.families[a].qty);
  if (!fams.length) { $("#nonPickingCards").innerHTML = `<p class="muted">Nenhuma zona não-picking nos filtros.</p>`; return; }
  $("#nonPickingCards").innerHTML = fams.map(fam => {
    const f = A.families[fam];
    return `<div class="np-card">
      <div class="np-zone">${fam}</div>
      <div class="np-cls">${ZONE_CLASS[fam] || "Outros"}</div>
      <div class="np-qty">${fmtInt(f.qty)}</div>
      <div class="np-meta">${fmtInt(f.skuSet.size)} SKU · ${fmtInt(f.locSet.size)} end.</div>
    </div>`;
  }).join("");
}

function renderHeatmap(A) {
  const cells = {}; const streetSet = {};
  PICKING_FAMILIES.forEach(f => cells[f] = {});
  for (const s of Object.values(A.streets)) { cells[s.family][s.street] = s; streetSet[s.street] = true; }
  const streets = Object.keys(streetSet).sort(cmpStreet);

  let html = `<div class="hm-row"><div class="hm-corner">Rua</div>` +
    PICKING_FAMILIES.map(f => `<div class="hm-colh">${f}</div>`).join("") + `</div>`;
  for (const st of streets) {
    html += `<div class="hm-row"><div class="hm-rowh">${st}</div>`;
    for (const f of PICKING_FAMILIES) {
      const s = cells[f][st];
      if (!s) { html += `<div class="hm-cell empty">·</div>`; continue; }
      const c = streetCapacity(s);
      html += `<div class="hm-cell" style="background:${colorFor(c.occ)}"
        data-tip='${JSON.stringify({ st, f, qty: s.qty, sku: s.skuSet.size, addr: c.addresses, cap: c.cap, occ: c.occ })}'>${Math.round(c.occ)}%</div>`;
    }
    html += `</div>`;
  }
  $("#heatmap").innerHTML = streets.length ? html : `<p class="muted">Sem dados de picking para os filtros atuais.</p>`;
  $("#heatScale").innerHTML = HEAT_SCALE.map(s => `<span class="sw"><span class="box" style="background:${s.color}"></span>${s.label}</span>`).join("");

  const tip = $("#heatTooltip");
  $$("#heatmap .hm-cell:not(.empty)").forEach(cell => {
    cell.addEventListener("mousemove", e => {
      const d = JSON.parse(cell.dataset.tip);
      tip.hidden = false;
      tip.innerHTML = `<div class="tt-row"><span>Rua</span><b>${d.f}-${d.st}</b></div>
        <div class="tt-row"><span>Peças</span><b>${fmtInt(d.qty)}</b></div>
        <div class="tt-row"><span>SKU</span><b>${fmtInt(d.sku)}</b></div>
        <div class="tt-row"><span>Endereços</span><b>${fmtInt(d.addr)}</b></div>
        <div class="tt-row"><span>Capacidade</span><b>${fmtInt(d.cap)}</b></div>
        <div class="tt-row"><span>Ocupação</span><b>${pctTxt(d.occ)}</b></div>`;
      const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > innerWidth) x = e.clientX - w - pad;
      if (y + h > innerHeight) y = e.clientY - h - pad;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });
    cell.addEventListener("mouseleave", () => tip.hidden = true);
  });
}

function renderZoneCards(A) {
  $("#zoneCards").innerHTML = PICKING_FAMILIES.map(fam => {
    const f = A.families[fam];
    if (!f) return `<div class="zone-card"><div class="zc-head"><span class="zc-name">${fam}</span>
      <span class="zc-badge" style="background:#c4c9d4">sem dados</span></div></div>`;
    const c = familyCapacity(f, fam); const col = colorFor(c.occ);
    return `<div class="zone-card">
      <div class="zc-head"><span class="zc-name">${fam}</span>
        <span class="zc-badge" style="background:${col}">${pctTxt(c.occ)}</span></div>
      <div class="zc-stats">
        <span>Peças<b>${fmtInt(f.qty)}</b></span><span>SKU<b>${fmtInt(f.skuSet.size)}</b></span>
        <span>Endereços<b>${fmtInt(c.addresses)}</b></span><span>Capac.<b>${fmtInt(c.cap)}</b></span>
      </div>
      <div class="zc-bar"><i style="width:${Math.min(100, c.occ)}%;background:${col}"></i></div>
      <div class="zc-occ"><span>Livre: ${fmtInt(c.free)}</span><span>${pctTxt(c.occ)}</span></div>
    </div>`;
  }).join("");
}

function renderCapacity(A) {
  $("#capacityPanel").innerHTML = PICKING_FAMILIES.map(fam => {
    const f = A.families[fam]; if (!f) return "";
    const c = familyCapacity(f, fam);
    return `<div class="cap-row">
      <div class="cap-top"><b>${fam}</b><span>${fmtInt(f.qty)} / ${fmtInt(c.cap)}</span></div>
      <div class="cap-track"><div class="cap-fill" style="width:${Math.min(100, c.occ)}%;background:${colorFor(c.occ)}"></div></div>
      <div class="cap-free">Livre: <b>${fmtInt(c.free)}</b> peças · ${pctTxt(c.occ)} ocupado</div>
    </div>`;
  }).join("") || `<p class="muted">Sem zonas de picking nos filtros.</p>`;
}

function renderDistro(A) {
  const fams = Object.keys(A.families).sort((a, b) => A.families[b].qty - A.families[a].qty);
  const data = fams.map(f => A.families[f].qty);
  const opts = {
    chart: { type: "donut", height: 280 }, series: data, labels: fams,
    colors: ["#EE4D2D", "#FF7337", "#1C2434", "#f5b50a", "#16a34a", "#6366f1", "#0ea5e9", "#a855f7", "#64748b", "#f43f5e"],
    legend: { position: "bottom", fontFamily: "Inter" },
    dataLabels: { formatter: v => `${v.toFixed(0)}%` },
    plotOptions: { pie: { donut: { labels: { show: true, total: { show: true, label: "Total pç", fontFamily: "Sora", formatter: () => fmtInt(data.reduce((a, b) => a + b, 0)) } } } } },
    tooltip: { y: { formatter: v => `${fmtInt(v)} pç` } }
  };
  if (STATE.charts.distro) STATE.charts.distro.updateOptions(opts, true, true);
  else { STATE.charts.distro = new ApexCharts($("#distroDonut"), opts); STATE.charts.distro.render(); }
}

function renderTopStreets(A) {
  const rows = Object.values(A.streets).map(s => ({ ...s, ...streetCapacity(s) }))
    .sort((a, b) => b.occ - a.occ).slice(0, 10);
  const st = o => o.occ >= 90 ? "🔴" : o.occ >= 70 ? "🟡" : "🟢";
  $("#topStreets").innerHTML =
    `<thead><tr><th>Rua</th><th>Zona</th><th class="num">Peças</th><th class="num">SKU</th><th class="num">Ocup.</th><th>St</th></tr></thead>
     <tbody>${rows.map(r => `<tr><td><b>${r.family}-${r.street}</b></td><td>${r.family}</td>
        <td class="num">${fmtInt(r.qty)}</td><td class="num">${fmtInt(r.skuSet.size)}</td>
        <td class="num" style="color:${colorFor(r.occ)}">${pctTxt(r.occ)}</td><td class="pill-status">${st(r)}</td></tr>`).join("")
       || `<tr><td colspan="6" class="muted">Sem dados</td></tr>`}</tbody>`;
}

function renderTopSku(A) {
  const byQty = Object.values(A.skuQty).sort((a, b) => b.qty - a.qty).slice(0, 10);
  $("#topSkuQty").innerHTML =
    `<thead><tr><th>SKU Name</th><th>SKU ID</th><th class="num">Qty</th></tr></thead>
     <tbody>${byQty.map(s => `<tr><td>${(s.name || "—").slice(0, 36)}</td><td>${s.id}</td><td class="num">${fmtInt(s.qty)}</td></tr>`).join("")
       || `<tr><td colspan="3" class="muted">Sem dados</td></tr>`}</tbody>`;
}

/* =====================================================================
   4) FILTRO POR ZONA (topo)
   ===================================================================== */
function buildZoneChips() {
  const fams = Array.from(new Set(STATE.raw.map(r => r.family))).filter(Boolean).sort();
  const chip = (val, label, active) => `<button class="zchip ${active ? "active" : ""}" data-zone="${val}">${label}</button>`;
  let html = chip("__ALL__", "Todas", STATE.zones.size === 0);
  html += fams.map(f => chip(f, f, STATE.zones.has(f))).join("");
  $("#zoneChips").innerHTML = html;
  $$("#zoneChips .zchip").forEach(b => b.addEventListener("click", () => {
    const z = b.dataset.zone;
    if (z === "__ALL__") STATE.zones.clear();
    else { STATE.zones.has(z) ? STATE.zones.delete(z) : STATE.zones.add(z); }
    refreshChipsActive(); applyFilters();
  }));
}
function refreshChipsActive() {
  $$("#zoneChips .zchip").forEach(b => {
    const z = b.dataset.zone;
    b.classList.toggle("active", z === "__ALL__" ? STATE.zones.size === 0 : STATE.zones.has(z));
  });
}
function applyFilters() {
  STATE.filtered = STATE.zones.size ? STATE.raw.filter(r => STATE.zones.has(r.family)) : STATE.raw;
  renderAll();
}

/* =====================================================================
   5) EVENTOS / INIT / REFRESH
   ===================================================================== */
async function refresh() {
  const btn = $("#btnRefresh"); btn.classList.add("spin");
  try {
    await loadData();
    buildZoneChips();
    applyFilters();
  } catch (e) {
    console.error("[dash] erro no refresh:", e);
    $("#footStatus").textContent = "Erro: " + e.message;
  } finally {
    $("#lastUpdate").textContent = "Atualizado " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    setLoader(false);                       // garante que o loader sempre some
    setTimeout(() => btn.classList.remove("spin"), 600);
  }
}
function startAutoRefresh() {
  if (STATE.refreshTimer) clearInterval(STATE.refreshTimer);
  STATE.refreshTimer = setInterval(refresh, Math.max(1, CONFIG.AUTO_REFRESH_MINUTES) * 60000);
}
async function init() {
  $("#btnRefresh").addEventListener("click", refresh);
  await refresh();
  startAutoRefresh();
}

/* =====================================================================
   6) DEMONSTRAÇÃO
   ===================================================================== */
function buildDemoData() {
  const rows = [];
  const names = ["Fone Bluetooth TWS", "Carregador Turbo 30W", "Camiseta Algodão", "Caneca Cerâmica", "Mouse Gamer RGB",
    "Garrafa Térmica 1L", "Luminária LED", "Tênis Esportivo", "Mochila Notebook", "Smartwatch Fit", "Cabo USB-C 2m",
    "Teclado Mecânico", "Air Fryer 4L", "Ventilador de Mesa", "Power Bank 20000", "Headset Gamer", "Echo Dot"];
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const numFam = { A2: { st: 26, ad: 6, fill: .55 }, HV: { st: 12, ad: 5, fill: .6 }, BL: { st: 10, ad: 5, fill: .65 }, M2: { st: 16, ad: 5, fill: .5 } };
  const hsZones = ["HS2", "HS3", "HS4", "HS5", "HS6", "HS9", "HS10", "HS13", "HS15", "HS20", "HS21", "HS24"];
  let sku = 1000;
  const emit = (family, zoneRaw, locId, intensity) => {
    const cap = CAPACITY[family] ?? 15, n = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      const qty = Math.max(1, Math.round(cap * intensity / n * rnd(.7, 1.3)));
      rows.push(makeRecord({ loc: locId, zone: zoneRaw, qty, skuId: "SKU" + (sku++), skuName: pick(names) }));
    }
  };
  for (const [fam, c] of Object.entries(numFam))
    for (let s = 1; s <= c.st; s++) {
      const hot = Math.random() < .18 ? rnd(1, 1.25) : c.fill * rnd(.7, 1.3);
      for (let a = 1; a <= c.ad; a++) {
        if (Math.random() < .12) continue;
        emit(fam, fam, `BRFPE1-${fam}-${String(s).padStart(2, "0")}-${String(a).padStart(2, "0")}-1-${String(Math.floor(rnd(1, 300))).padStart(3, "0")}`, Math.min(1.3, hot));
      }
    }
  for (const hz of hsZones) {
    const addr = 8 + Math.floor(rnd(0, 14)), fill = Math.random() < .2 ? rnd(.95, 1.15) : rnd(.45, .85);
    for (let a = 1; a <= addr; a++)
      emit("HS", hz, `BRFPE1-${hz}-${String(Math.floor(rnd(1, 30))).padStart(2, "0")}-${String(a).padStart(2, "0")}-${String(Math.floor(rnd(1, 999))).padStart(3, "0")}`, Math.min(1.2, fill * rnd(.8, 1.2)));
  }
  // não-picking
  const npZones = [["AV", 40], ["MI", 14], ["MTU", 10], ["OS", 12], ["MO", 8], ["DEM", 6], ["RTS", 9], ["RO", 5]];
  for (const [z, k] of npZones)
    for (let a = 1; a <= k; a++)
      emit(z, z, `BRFPE1-${z}-${String(Math.floor(rnd(1, 8))).padStart(2, "0")}-${String(a).padStart(2, "0")}-1-${String(Math.floor(rnd(1, 200))).padStart(3, "0")}`, rnd(.4, .9));
  return rows;
}

document.addEventListener("DOMContentLoaded", init);
