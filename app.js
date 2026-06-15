/* =====================================================================
   CAD PE — Dashboard de Ocupação de Armazenagem (Shopee Fulfillment)
   Stack: ES6 + Bootstrap 5 + Chart.js + ApexCharts
   Fonte de dados: Google Apps Script Web App (doGet -> JSON)
   ---------------------------------------------------------------------
   ÚNICO ponto a editar -> APPS_SCRIPT_URL (cole a URL /exec uma vez).
   Depois disso o dashboard carrega sozinho, sem upload e sem config.
   ===================================================================== */

/* ----------------------- CONFIGURAÇÃO ----------------------- */
const CONFIG = {
  // Cole aqui a URL terminada em /exec gerada na implantação do Web App.
  // Ex.: "https://script.google.com/macros/s/AKfycbyLaCGo0j8F04xtxtHTyi4_eAEe1M1emkONbg-ZKTpg9adKquMLMxcyr4dVgtqI0hM/exec"
  APPS_SCRIPT_URL: "",
  AUTO_REFRESH_MINUTES: 5
};

/* Capacidade por endereço (peças). Bin = 15, Pallet (HS) = 12 */
const CAPACITY = { A2: 15, HV: 15, BL: 15, M2: 15, HS: 12 };

/* Famílias exibidas no heatmap principal / cards */
const PICKING_FAMILIES = ["A2", "HS", "HV", "BL", "M2"];
const ZONE_CARD_ORDER  = ["A2", "HS", "HV", "BL", "M2", "AV"];

/* Classificação macro das zonas (para Stock Type / contexto) */
const ZONE_CLASS = {
  PICKING: ["A2", "BL", "HV", "M2", "HS"],
  AV: ["AV"], INBOUND: ["MI", "MTU"], OUTBOUND: ["OS", "MO"],
  BUFFER: ["D"], DAMAGE: ["DEM"], RETURNS: ["RTS"], VIRTUAL: ["RO", "TS"]
};

/* Escala de cores de ocupação */
const HEAT_SCALE = [
  { max: 40,  color: "#16a34a", label: "0–40%" },
  { max: 70,  color: "#f5b50a", label: "40–70%" },
  { max: 90,  color: "#f97316", label: "70–90%" },
  { max: 110, color: "#e11d48", label: "90–110%" },
  { max: Infinity, color: "#9f1239", label: "110%+" }
];
const colorFor = pct => (HEAT_SCALE.find(s => pct < s.max) || HEAT_SCALE.at(-1)).color;

/* ----------------------- ESTADO ----------------------- */
const STATE = {
  raw: [],            // todas as linhas normalizadas
  filtered: [],       // após filtros
  charts: {},         // instâncias de gráficos
  refreshTimer: null
};

/* ----------------------- HELPERS ----------------------- */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const fmtInt = n => Math.round(n || 0).toLocaleString("pt-BR");
const fmtNum = (n, d = 1) => (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const pctTxt = n => `${fmtNum(n, 1)}%`;
const uniq = arr => Array.from(new Set(arr));
const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : 0; };

function setLoader(show, msg) {
  const el = $("#loader");
  if (msg) $("#loaderMsg").textContent = msg;
  el.classList.toggle("hide", !show);
}

/* Mapeia uma zona/localização para a família do Picking */
function familyOf(zoneRaw, locId) {
  const z = String(zoneRaw || "").toUpperCase().trim();
  if (z.startsWith("HS")) return "HS";
  if (["A2", "HV", "BL", "M2", "AV"].includes(z)) return z;
  // fallback: tentar pela Location ID
  const parts = String(locId || "").toUpperCase().split("-");
  const p1 = parts[1] || "";
  if (p1.startsWith("HS")) return "HS";
  if (["A2", "HV", "BL", "M2", "AV"].includes(p1)) return p1;
  return z || p1 || "OUTROS";
}

/* Extrai a "rua" a partir da Location ID conforme as regras do brief.
   A2/HV/BL/M2 -> número após o código da zona (parts[2])
   HS          -> a própria sigla HSx (parts[1])                       */
function streetOf(family, locId) {
  const parts = String(locId || "").toUpperCase().split("-");
  if (family === "HS") return (parts[1] || "HS").replace(/[^A-Z0-9]/g, "");
  // A2 / HV / BL / M2 / AV: número da rua
  const n = parts[2];
  return n != null ? String(parseInt(n, 10) || n).padStart(2, "0") : "—";
}

/* Classe macro de uma família */
function macroClass(family) {
  for (const [cls, list] of Object.entries(ZONE_CLASS))
    if (list.includes(family)) return cls;
  return "OUTROS";
}

/* Idade (dias) a partir da Inbound Date */
function ageDays(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}
function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  // dd/mm/yyyy
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2] - 1, +m[1]); }
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s); return isNaN(d) ? null : d;
}
const isoDate = d => d ? d.toISOString().slice(0, 10) : "";

/* =====================================================================
   1) CARREGAMENTO DE DADOS — Google Apps Script Web App (doGet -> JSON)
   Funciona com planilhas corporativas (shopee.com) sem deixá-las públicas.
   ===================================================================== */
async function loadData() {
  const url = (CONFIG.APPS_SCRIPT_URL || "").trim();
  if (url) {
    try {
      setLoader(true, "Conectando ao Web App…");
      const rows = await fetchAppsScript(url);
      STATE.raw = rows.map(normalizeRow).filter(r => r.locId || r.skuId);
      $("#footStatus").textContent = `Fonte: Apps Script · ${fmtInt(STATE.raw.length)} registros`;
      if (STATE.raw.length) return;
      $("#footStatus").textContent = "⚠ Web App respondeu sem registros — verifique a aba 'Base'";
    } catch (e) {
      console.error("Falha ao ler o Web App:", e);
      $("#footStatus").textContent = "⚠ Web App indisponível — exibindo dados de demonstração";
    }
  } else {
    $("#footStatus").textContent = "Modo demonstração — cole a URL em CONFIG.APPS_SCRIPT_URL";
  }
  // Fallback: dados sintéticos para renderizar o dashboard mesmo sem conexão
  setLoader(true, "Gerando base de demonstração…");
  STATE.raw = buildDemoData();
}

/* Busca o JSON do Web App. O doGet retorna { ok, count, rows: [...] }.
   O fetch segue o redirect 302 do Apps Script para googleusercontent.com. */
async function fetchAppsScript(url) {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}t=${Date.now()}`, { method: "GET", redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.ok === false) throw new Error(data.error || "Erro no Web App");
  // aceita {rows:[...]} ou um array direto
  return Array.isArray(data) ? data : (data.rows || []);
}

/* Normaliza nomes de colunas variáveis -> chaves internas */
function normalizeRow(r) {
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(r).find(x => x.toLowerCase().trim() === k.toLowerCase());
      if (found != null && r[found] !== "") return r[found];
    } return "";
  };
  const locId  = String(get("Location ID", "LocationID", "Location") || "");
  const zoneRaw = String(get("Zone") || "");
  const family = familyOf(zoneRaw, locId);
  const qty = num(get("Qty", "Quantidade"));
  const L = num(get("Lenght", "Length", "Comprimento"));
  const W = num(get("Width", "Largura"));
  const H = num(get("Height", "Altura"));
  const inbound = get("Inbound Date", "InboundDate");
  const date = get("Date", "Data");
  const bulkyRaw = String(get("Is Bulky", "IsBulky", "Bulky")).toLowerCase().trim();
  const isBulky = ["1", "true", "sim", "yes", "y"].includes(bulkyRaw);
  return {
    date: parseDate(date), dateStr: isoDate(parseDate(date)),
    skuId: String(get("SKU ID", "SKUID", "SKU") || ""),
    skuName: String(get("SKU Name", "SKUName", "Nome") || ""),
    L, W, H, family, zoneRaw, locId,
    street: streetOf(family, locId),
    stockType: String(get("Stock Type", "StockType") || "—"),
    batch: String(get("Batch No", "BatchNo", "Lote") || ""),
    inbound: parseDate(inbound), inboundStr: isoDate(parseDate(inbound)),
    isBulky, qty,
    listingPrice: num(get("Listing Price", "ListingPrice")),
    unitCogs: num(get("Unit COGS", "UnitCOGS")),
    skuValue: num(get("SKU Value", "SKUValue")),
    cubM3: (L * W * H * qty) / 1e9  // mm³ -> m³ (assume dimensões em mm)
  };
}

/* =====================================================================
   2) MOTOR DE AGREGAÇÃO
   ===================================================================== */
function aggregate(rows) {
  const A = {
    totalQty: 0, cubTotal: 0,
    skuSet: new Set(), locSet: new Set(),
    families: {},        // por família: {qty,cub,skuSet,locSet,bulkyQty}
    streets: {},         // chave family|street
    skuQty: {}, skuCub: {},
    bulky: { qty: 0, cub: 0, skuSet: new Set() },
    age: { "0-30": q0(), "31-60": q0(), "61-90": q0(), "91-180": q0(), "180+": q0() },
    daily: {}
  };
  function q0() { return { qty: 0, skuSet: new Set() }; }

  for (const r of rows) {
    A.totalQty += r.qty;
    A.cubTotal += r.cubM3;
    if (r.skuId) A.skuSet.add(r.skuId);
    if (r.locId) A.locSet.add(r.locId);

    // família
    const f = A.families[r.family] || (A.families[r.family] = { qty: 0, cub: 0, skuSet: new Set(), locSet: new Set(), bulkyQty: 0 });
    f.qty += r.qty; f.cub += r.cubM3;
    if (r.skuId) f.skuSet.add(r.skuId);
    if (r.locId) f.locSet.add(r.locId);
    if (r.isBulky) f.bulkyQty += r.qty;

    // rua (somente famílias de picking dão heatmap)
    const sk = `${r.family}|${r.street}`;
    const s = A.streets[sk] || (A.streets[sk] = { family: r.family, street: r.street, qty: 0, cub: 0, skuSet: new Set(), locSet: new Set() });
    s.qty += r.qty; s.cub += r.cubM3;
    if (r.skuId) s.skuSet.add(r.skuId);
    if (r.locId) s.locSet.add(r.locId);

    // SKU rankings
    if (r.skuId) {
      const sq = A.skuQty[r.skuId] || (A.skuQty[r.skuId] = { id: r.skuId, name: r.skuName, qty: 0 });
      sq.qty += r.qty; if (!sq.name && r.skuName) sq.name = r.skuName;
      const sc = A.skuCub[r.skuId] || (A.skuCub[r.skuId] = { id: r.skuId, name: r.skuName, cub: 0 });
      sc.cub += r.cubM3;
    }

    // bulky
    if (r.isBulky) { A.bulky.qty += r.qty; A.bulky.cub += r.cubM3; if (r.skuId) A.bulky.skuSet.add(r.skuId); }

    // idade
    const ad = ageDays(r.inbound);
    if (ad != null) {
      const band = ad <= 30 ? "0-30" : ad <= 60 ? "31-60" : ad <= 90 ? "61-90" : ad <= 180 ? "91-180" : "180+";
      A.age[band].qty += r.qty; if (r.skuId) A.age[band].skuSet.add(r.skuId);
    }

    // diário
    if (r.dateStr) {
      const d = A.daily[r.dateStr] || (A.daily[r.dateStr] = { qty: 0, skuSet: new Set(), locSet: new Set() });
      d.qty += r.qty; if (r.skuId) d.skuSet.add(r.skuId); if (r.locId) d.locSet.add(r.locId);
    }
  }
  return A;
}

/* Capacidade e ocupação de uma "rua" agregada */
function streetCapacity(s) {
  const perAddr = CAPACITY[s.family] ?? (s.family === "HS" ? 12 : 15);
  const addresses = s.locSet.size;
  const cap = addresses * perAddr;
  return { addresses, perAddr, cap, occ: cap > 0 ? (s.qty / cap) * 100 : 0 };
}
function familyCapacity(f, familyKey) {
  const perAddr = CAPACITY[familyKey] ?? (familyKey === "HS" ? 12 : 15);
  const addresses = f.locSet.size;
  const cap = addresses * perAddr;
  return { addresses, perAddr, cap, free: Math.max(0, cap - f.qty), occ: cap > 0 ? (f.qty / cap) * 100 : 0 };
}

/* =====================================================================
   3) HEALTH SCORE PICKING
   70% ocupação · 20% densidade SKU · 10% endereços livres
   ===================================================================== */
function healthScore(A) {
  // Ocupação média ponderada das famílias de picking (alvo ~85%)
  let occW = 0, occQty = 0, densSum = 0, densN = 0, freeRatioSum = 0, freeN = 0;
  for (const fam of ["A2", "HS", "HV", "BL", "M2"]) {
    const f = A.families[fam]; if (!f) continue;
    const cap = familyCapacity(f, fam);
    occW += cap.occ * f.qty; occQty += f.qty;
    // densidade ideal: poucos SKU por endereço
    const dens = cap.addresses > 0 ? f.skuSet.size / cap.addresses : 0;
    densSum += dens; densN++;
    freeRatioSum += cap.cap > 0 ? cap.free / cap.cap : 0; freeN++;
  }
  const occAvg = occQty > 0 ? occW / occQty : 0;
  // pontuação de ocupação: penaliza desvio do alvo (85%)
  const occScore = Math.max(0, 100 - Math.abs(occAvg - 85) * 1.1);
  const densAvg = densN ? densSum / densN : 0;
  const densScore = Math.max(0, 100 - Math.max(0, densAvg - 1.5) * 25); // >1.5 SKU/end começa a penalizar
  const freeAvg = freeN ? freeRatioSum / freeN : 0;
  const freeScore = Math.min(100, freeAvg / 0.20 * 100); // 20% livre = ótimo
  const score = occScore * 0.7 + densScore * 0.2 + freeScore * 0.1;
  return Math.max(0, Math.min(100, Math.round(score)));
}
function scoreLabel(s) {
  if (s >= 95) return { t: "Excelente", c: "#16a34a" };
  if (s >= 85) return { t: "Bom", c: "#65a30d" };
  if (s >= 70) return { t: "Atenção", c: "#f5b50a" };
  return { t: "Crítico", c: "#e11d48" };
}

/* =====================================================================
   4) RENDERIZAÇÃO
   ===================================================================== */
function renderAll() {
  const A = aggregate(STATE.filtered);
  renderKPIs(A);
  renderSaturation(A);
  renderTower(A);
  renderHealth(A);
  renderHeatmap(A);
  renderZoneCards(A);
  renderCapacity(A);
  renderDistro(A);
  renderTopStreets(A);
  renderTopSku(A);
  renderDensity(A);
  renderBulky(A);
  renderAge(A);
  renderDaily(A);
  renderAlerts(A);
  $("#rowsInfo").textContent = `${fmtInt(STATE.filtered.length)} de ${fmtInt(STATE.raw.length)} registros`;
}

/* ---- KPIs ---- */
function renderKPIs(A) {
  const pick = pickingOcc(A);
  const av = A.families.AV ? familyCapacity(A.families.AV, "AV") : { occ: 0 };
  const cards = [
    { lbl: "Total de Peças", val: fmtInt(A.totalQty), sub: "Σ Qty", ico: "bi-boxes" },
    { lbl: "SKU Ativos", val: fmtInt(A.skuSet.size), sub: "SKU ID distintos", ico: "bi-upc-scan" },
    { lbl: "Endereços", val: fmtInt(A.locSet.size), sub: "Location ID distintos", ico: "bi-geo-alt-fill" },
    { lbl: "Cubagem Total", val: fmtNum(A.cubTotal, 1), sub: "m³ (L×W×H×Qty)", ico: "bi-box" },
    { lbl: "Picking Occ.", val: pctTxt(pick), sub: "zonas de picking", ico: "bi-bezier2" },
    { lbl: "AV Occupancy", val: pctTxt(av.occ), sub: "zona AV", ico: "bi-archive-fill" }
  ];
  $("#kpiGrid").innerHTML = cards.map(c => `
    <div class="kpi">
      <i class="bi ${c.ico} kpi-ico"></i>
      <div class="kpi-label">${c.lbl}</div>
      <div class="kpi-value">${c.val}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`).join("");
}

function pickingOcc(A) {
  let qty = 0, cap = 0;
  for (const fam of ["A2", "HS", "HV", "BL", "M2"]) {
    const f = A.families[fam]; if (!f) continue;
    const c = familyCapacity(f, fam); qty += f.qty; cap += c.cap;
  }
  return cap > 0 ? (qty / cap) * 100 : 0;
}

/* ---- Saturação geral ---- */
function renderSaturation(A) {
  const occ = pickingOcc(A);
  const pill = $("#saturationPill");
  let cls, txt;
  if (occ >= 90) { cls = "crit"; txt = "🔴 Crítico"; }
  else if (occ >= 75) { cls = "warn"; txt = "🟡 Atenção"; }
  else { cls = "ok"; txt = "🟢 Saudável"; }
  pill.className = `saturation-pill ${cls}`;
  pill.querySelector(".label").textContent = `${txt} · ${pctTxt(occ)}`;
}

/* ---- Torre de Controle ---- */
function renderTower(A) {
  let totalCap = 0, usedCap = 0;
  for (const fam of ["A2", "HS", "HV", "BL", "M2"]) {
    const f = A.families[fam]; if (!f) continue;
    const c = familyCapacity(f, fam); totalCap += c.cap; usedCap += f.qty;
  }
  // zona mais crítica
  let critFam = null, critFamOcc = -1;
  for (const fam of ["A2", "HS", "HV", "BL", "M2"]) {
    const f = A.families[fam]; if (!f) continue;
    const c = familyCapacity(f, fam);
    if (c.occ > critFamOcc) { critFamOcc = c.occ; critFam = fam; }
  }
  // rua mais crítica
  let critStreet = null, critOcc = -1;
  for (const s of Object.values(A.streets)) {
    if (!PICKING_FAMILIES.includes(s.family)) continue;
    const c = streetCapacity(s);
    if (c.occ > critOcc) { critOcc = c.occ; critStreet = s; }
  }
  // maior consumidor de espaço (cubagem)
  const topCub = Object.values(A.skuCub).sort((a, b) => b.cub - a.cub)[0];
  const bulkyPct = A.totalQty > 0 ? (A.bulky.qty / A.totalQty) * 100 : 0;
  const hs = healthScore(A); const sl = scoreLabel(hs);

  const items = [
    { l: "Capacidade Total", v: `${fmtInt(totalCap)} pç` },
    { l: "Utilizada", v: `${fmtInt(usedCap)} pç` },
    { l: "Livre", v: `${fmtInt(Math.max(0, totalCap - usedCap))} pç` },
    { l: "Ocupação Picking", v: pctTxt(pickingOcc(A)) },
    { l: "Zona + Crítica", v: critFam ? `${critFam} · ${pctTxt(critFamOcc)}` : "—" },
    { l: "Rua + Crítica", v: critStreet ? `${critStreet.family}-${critStreet.street} · ${pctTxt(critOcc)}` : "—" },
    { l: "Maior Consumidor m³", v: topCub ? (topCub.name || topCub.id).slice(0, 22) : "—", sm: true },
    { l: "% Bulky / Health", v: `${pctTxt(bulkyPct)} · <span style="color:${sl.c}">${hs}</span>` }
  ];
  $("#towerGrid").innerHTML = items.map(i => `
    <div class="tower-item">
      <div class="t-lbl">${i.l}</div>
      <div class="t-val ${i.sm ? "sm" : ""}">${i.v}</div>
    </div>`).join("");
}

/* ---- Health Gauge (ApexCharts radialBar) ---- */
function renderHealth(A) {
  const score = healthScore(A); const sl = scoreLabel(score);
  const opts = {
    chart: { type: "radialBar", height: 230, sparkline: { enabled: true } },
    series: [score],
    colors: [sl.c],
    plotOptions: { radialBar: {
      hollow: { size: "62%" },
      track: { background: "#EAEAEA" },
      dataLabels: {
        name: { offsetY: 22, color: "#7B8499", fontSize: "13px", fontFamily: "Inter" },
        value: { offsetY: -18, fontSize: "34px", fontWeight: 800, color: "#1C2434", fontFamily: "Sora", formatter: v => Math.round(v) }
      }
    }},
    labels: [sl.t], stroke: { lineCap: "round" }
  };
  if (STATE.charts.health) { STATE.charts.health.updateOptions(opts); }
  else { STATE.charts.health = new ApexCharts($("#healthGauge"), opts); STATE.charts.health.render(); }
  $("#healthLegend").innerHTML =
    `<span>95–100 <b>Excelente</b></span><span>85–94 <b>Bom</b></span>` +
    `<span>70–84 <b>Atenção</b></span><span>&lt;70 <b>Crítico</b></span>`;
}

/* ---- Heatmap principal ---- */
function renderHeatmap(A) {
  // monta matriz: linhas = streets (união), colunas = PICKING_FAMILIES
  const cells = {};       // family -> street -> data
  const streetSet = {};   // streetKey -> true (para ordenação)
  PICKING_FAMILIES.forEach(f => cells[f] = {});
  for (const s of Object.values(A.streets)) {
    if (!PICKING_FAMILIES.includes(s.family)) continue;
    cells[s.family][s.street] = s;
    streetSet[s.street] = true;
  }
  const streets = Object.keys(streetSet).sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });

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
  $("#heatmap").innerHTML = html || `<p class="muted">Sem dados de picking para os filtros atuais.</p>`;

  // escala
  $("#heatScale").innerHTML = HEAT_SCALE.map(s =>
    `<span class="sw"><span class="box" style="background:${s.color}"></span>${s.label}</span>`).join("");

  // tooltip
  const tip = $("#heatTooltip");
  $$("#heatmap .hm-cell:not(.empty)").forEach(cell => {
    cell.addEventListener("mousemove", e => {
      const d = JSON.parse(cell.dataset.tip);
      tip.hidden = false;
      tip.innerHTML =
        `<div class="tt-row"><span>Rua</span><b>${d.f}-${d.st}</b></div>` +
        `<div class="tt-row"><span>Zona</span><b>${d.f}</b></div>` +
        `<div class="tt-row"><span>Peças</span><b>${fmtInt(d.qty)}</b></div>` +
        `<div class="tt-row"><span>SKU</span><b>${fmtInt(d.sku)}</b></div>` +
        `<div class="tt-row"><span>Endereços</span><b>${fmtInt(d.addr)}</b></div>` +
        `<div class="tt-row"><span>Capacidade</span><b>${fmtInt(d.cap)}</b></div>` +
        `<div class="tt-row"><span>Ocupação</span><b>${pctTxt(d.occ)}</b></div>`;
      const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > innerWidth) x = e.clientX - w - pad;
      if (y + h > innerHeight) y = e.clientY - h - pad;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });
    cell.addEventListener("mouseleave", () => tip.hidden = true);
  });
}

/* ---- Cards de Zona ---- */
function renderZoneCards(A) {
  const html = ZONE_CARD_ORDER.map(fam => {
    const f = A.families[fam];
    if (!f) return `<div class="zone-card"><div class="zc-head"><span class="zc-name">${fam}</span>
      <span class="zc-badge" style="background:#c4c9d4">sem dados</span></div>
      <div class="zc-stats"><span>Peças<b>0</b></span></div></div>`;
    const c = familyCapacity(f, fam);
    const col = colorFor(c.occ);
    return `<div class="zone-card">
      <div class="zc-head">
        <span class="zc-name">${fam}</span>
        <span class="zc-badge" style="background:${col}">${pctTxt(c.occ)}</span>
      </div>
      <div class="zc-stats">
        <span>Peças<b>${fmtInt(f.qty)}</b></span>
        <span>SKU<b>${fmtInt(f.skuSet.size)}</b></span>
        <span>Endereços<b>${fmtInt(c.addresses)}</b></span>
        <span>Capac.<b>${fmtInt(c.cap)}</b></span>
        <span>Livre<b>${fmtInt(c.free)}</b></span>
        <span>Cub. m³<b>${fmtNum(f.cub, 1)}</b></span>
      </div>
      <div class="zc-bar"><i style="width:${Math.min(100, c.occ)}%;background:${col}"></i></div>
      <div class="zc-occ"><span>Ocupação</span><span>${pctTxt(c.occ)}</span></div>
    </div>`;
  }).join("");
  $("#zoneCards").innerHTML = html;
}

/* ---- Capacidade Disponível ---- */
function renderCapacity(A) {
  const html = ["A2", "HS", "HV", "BL", "M2"].map(fam => {
    const f = A.families[fam]; if (!f) return "";
    const c = familyCapacity(f, fam);
    return `<div class="cap-row">
      <div class="cap-top"><b>${fam}</b><span>${fmtInt(f.qty)} / ${fmtInt(c.cap)}</span></div>
      <div class="cap-track"><div class="cap-fill" style="width:${Math.min(100, c.occ)}%;
        background:linear-gradient(90deg,${colorFor(c.occ)},${colorFor(c.occ)}cc)"></div></div>
      <div class="cap-free">Livre: <b>${fmtInt(c.free)}</b> peças · ${pctTxt(c.occ)} ocupado</div>
    </div>`;
  }).join("");
  $("#capacityPanel").innerHTML = html || `<p class="muted">Sem zonas de picking nos filtros.</p>`;
}

/* ---- Donut distribuição ---- */
function renderDistro(A) {
  const fams = ZONE_CARD_ORDER.filter(f => A.families[f]);
  const data = fams.map(f => A.families[f].qty);
  const opts = {
    chart: { type: "donut", height: 280 },
    series: data, labels: fams,
    colors: ["#EE4D2D", "#FF7337", "#1C2434", "#f5b50a", "#16a34a", "#6366f1"],
    legend: { position: "bottom", fontFamily: "Inter" },
    dataLabels: { formatter: (v) => `${v.toFixed(0)}%` },
    plotOptions: { pie: { donut: { labels: { show: true,
      total: { show: true, label: "Total pç", fontFamily: "Sora",
        formatter: () => fmtInt(data.reduce((a, b) => a + b, 0)) } } } } },
    tooltip: { y: { formatter: v => `${fmtInt(v)} pç` } }
  };
  if (STATE.charts.distro) STATE.charts.distro.updateOptions(opts);
  else { STATE.charts.distro = new ApexCharts($("#distroDonut"), opts); STATE.charts.distro.render(); }
}

/* ---- Top 10 ruas críticas ---- */
function renderTopStreets(A) {
  const rows = Object.values(A.streets)
    .filter(s => PICKING_FAMILIES.includes(s.family))
    .map(s => ({ ...s, ...streetCapacity(s) }))
    .sort((a, b) => b.occ - a.occ).slice(0, 10);
  const st = o => o.occ >= 90 ? "🔴" : o.occ >= 70 ? "🟡" : "🟢";
  $("#topStreets").innerHTML =
    `<thead><tr><th>Rua</th><th>Zona</th><th class="num">Peças</th><th class="num">SKU</th><th class="num">Ocup.</th><th>St</th></tr></thead>
     <tbody>${rows.map(r => `<tr>
        <td><b>${r.family}-${r.street}</b></td><td>${r.family}</td>
        <td class="num">${fmtInt(r.qty)}</td><td class="num">${fmtInt(r.skuSet.size)}</td>
        <td class="num" style="color:${colorFor(r.occ)}">${pctTxt(r.occ)}</td>
        <td class="pill-status">${st(r)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">Sem dados</td></tr>`}</tbody>`;
}

/* ---- Top SKU (qty + cubagem) ---- */
function renderTopSku(A) {
  const byQty = Object.values(A.skuQty).sort((a, b) => b.qty - a.qty).slice(0, 10);
  $("#topSkuQty").innerHTML =
    `<thead><tr><th>SKU Name</th><th>SKU ID</th><th class="num">Qty</th></tr></thead>
     <tbody>${byQty.map(s => `<tr><td>${(s.name || "—").slice(0, 34)}</td><td>${s.id}</td>
        <td class="num">${fmtInt(s.qty)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">Sem dados</td></tr>`}</tbody>`;

  const byCub = Object.values(A.skuCub).sort((a, b) => b.cub - a.cub).slice(0, 10);
  const totCub = A.cubTotal || 1;
  $("#topSkuCub").innerHTML =
    `<thead><tr><th>SKU</th><th class="num">Cubagem m³</th><th class="num">Part.</th></tr></thead>
     <tbody>${byCub.map(s => {
        const part = (s.cub / totCub) * 100;
        return `<tr><td>${(s.name || s.id).slice(0, 30)}</td>
          <td class="num">${fmtNum(s.cub, 2)}</td>
          <td class="num"><span class="mini-bar"><i style="width:${Math.min(100, part)}%;background:var(--sh-orange)"></i></span>${pctTxt(part)}</td></tr>`;
      }).join("") || `<tr><td colspan="3" class="muted">Sem dados</td></tr>`}</tbody>`;
}

/* ---- Densidade de SKU por rua (heatmap secundário) ---- */
function renderDensity(A) {
  const rows = Object.values(A.streets)
    .filter(s => PICKING_FAMILIES.includes(s.family) && s.locSet.size > 0)
    .map(s => ({ key: `${s.family}-${s.street}`, dens: s.skuSet.size / s.locSet.size, sku: s.skuSet.size, addr: s.locSet.size }))
    .sort((a, b) => b.dens - a.dens).slice(0, 36);
  const maxD = Math.max(1, ...rows.map(r => r.dens));
  const densColor = d => {
    const t = d / maxD;
    if (t < 0.34) return "#16a34a";
    if (t < 0.67) return "#f5b50a";
    return "#e11d48";
  };
  $("#densityMap").innerHTML = rows.map(r =>
    `<div class="dens-cell" style="background:${densColor(r.dens)}" title="${r.sku} SKU / ${r.addr} end.">
      ${fmtNum(r.dens, 1)}<small>${r.key}</small></div>`).join("")
    || `<p class="muted">Sem dados.</p>`;
}

/* ---- Bulky ---- */
function renderBulky(A) {
  const pct = A.totalQty > 0 ? (A.bulky.qty / A.totalQty) * 100 : 0;
  const items = [
    { i: "bi-box-seam", l: "Peças Bulky", v: fmtInt(A.bulky.qty) },
    { i: "bi-upc", l: "SKU Bulky", v: fmtInt(A.bulky.skuSet.size) },
    { i: "bi-percent", l: "% Bulky", v: pctTxt(pct) },
    { i: "bi-aspect-ratio", l: "Cubagem Bulky m³", v: fmtNum(A.bulky.cub, 1) }
  ];
  $("#bulkyPanel").innerHTML = items.map(o =>
    `<div class="bulky-item"><i class="bi ${o.i}"></i><div class="b-val">${o.v}</div><div class="b-lbl">${o.l}</div></div>`).join("");
}

/* ---- Idade de estoque ---- */
function renderAge(A) {
  const bands = ["0-30", "31-60", "61-90", "91-180", "180+"];
  const qty = bands.map(b => A.age[b].qty);
  const sku = bands.map(b => A.age[b].skuSet.size);
  const tot = qty.reduce((a, b) => a + b, 0) || 1;
  const colors = ["#16a34a", "#65a30d", "#f5b50a", "#f97316", "#e11d48"];

  const ctx = $("#ageChart");
  if (STATE.charts.age) STATE.charts.age.destroy();
  STATE.charts.age = new Chart(ctx, {
    type: "bar",
    data: { labels: bands.map(b => b + " dias"),
      datasets: [{ label: "Peças", data: qty, backgroundColor: colors, borderRadius: 6 }] },
    options: { responsive: true, plugins: { legend: { display: false } },
      scales: { y: { ticks: { callback: v => fmtInt(v) } } } }
  });
  $("#ageTable").innerHTML =
    `<thead><tr><th>Faixa</th><th class="num">Peças</th><th class="num">SKU</th><th class="num">%</th></tr></thead>
     <tbody>${bands.map((b, i) => `<tr><td>${b} dias</td><td class="num">${fmtInt(qty[i])}</td>
        <td class="num">${fmtInt(sku[i])}</td><td class="num">${pctTxt(qty[i] / tot * 100)}</td></tr>`).join("")}</tbody>`;
}

/* ---- Evolução diária ---- */
function renderDaily(A) {
  const days = Object.keys(A.daily).sort();
  const qty = days.map(d => A.daily[d].qty);
  const sku = days.map(d => A.daily[d].skuSet.size);
  const loc = days.map(d => A.daily[d].locSet.size);
  const ctx = $("#dailyChart");
  if (STATE.charts.daily) STATE.charts.daily.destroy();
  STATE.charts.daily = new Chart(ctx, {
    type: "line",
    data: { labels: days.map(d => d.slice(5)),
      datasets: [
        { label: "Peças", data: qty, borderColor: "#EE4D2D", backgroundColor: "rgba(238,77,45,.12)", fill: true, tension: .3, yAxisID: "y" },
        { label: "SKU", data: sku, borderColor: "#1C2434", tension: .3, yAxisID: "y1" },
        { label: "Endereços", data: loc, borderColor: "#f5b50a", tension: .3, yAxisID: "y1" }
      ] },
    options: { responsive: true, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom" } },
      scales: {
        y: { position: "left", ticks: { callback: v => fmtInt(v) } },
        y1: { position: "right", grid: { drawOnChartArea: false } }
      } }
  });
}

/* ---- Alertas automáticos ---- */
function renderAlerts(A) {
  const alerts = [];
  for (const s of Object.values(A.streets)) {
    if (!PICKING_FAMILIES.includes(s.family)) continue;
    const c = streetCapacity(s);
    if (c.occ >= 100) alerts.push({ lvl: "crit", t: `Rua ${s.family}-${s.street} acima de 100% (${pctTxt(c.occ)})` });
    else if (c.occ >= 95) alerts.push({ lvl: "crit", t: `${s.family}-${s.street} acima de 95% (${pctTxt(c.occ)})` });
    else if (c.occ >= 85) alerts.push({ lvl: "warn", t: `${s.family} Rua ${s.street} acima de 85% (${pctTxt(c.occ)})` });
  }
  alerts.sort((a, b) => (a.lvl === "crit" ? -1 : 1) - (b.lvl === "crit" ? -1 : 1));
  const bar = $("#alertsBar");
  if (!alerts.length) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = alerts.slice(0, 12).map(a =>
    `<span class="alert-chip ${a.lvl}">${a.lvl === "crit" ? "🔴" : "🟡"} ${a.t}</span>`).join("");
}

/* =====================================================================
   5) FILTROS
   ===================================================================== */
function buildFilterOptions() {
  const zones = uniq(STATE.raw.map(r => r.family)).filter(Boolean).sort();
  const streets = uniq(STATE.raw.map(r => `${r.family}-${r.street}`)).filter(Boolean).sort();
  const types = uniq(STATE.raw.map(r => r.stockType)).filter(Boolean).sort();
  $("#fZone").innerHTML = zones.map(z => `<option value="${z}">${z}</option>`).join("");
  $("#fStreet").innerHTML = streets.map(s => `<option value="${s}">${s}</option>`).join("");
  $("#fStockType").innerHTML = `<option value="">Todos</option>` + types.map(t => `<option value="${t}">${t}</option>`).join("");
}

function applyFilters() {
  const sel = id => Array.from($(id).selectedOptions).map(o => o.value);
  const zones = sel("#fZone"), streets = sel("#fStreet");
  const type = $("#fStockType").value;
  const bulky = $("#fBulky").value;
  const q = $("#fSearch").value.trim().toLowerCase();
  const dFrom = $("#fDateFrom").value, dTo = $("#fDateTo").value;
  const iFrom = $("#fInboundFrom").value, iTo = $("#fInboundTo").value;

  STATE.filtered = STATE.raw.filter(r => {
    if (zones.length && !zones.includes(r.family)) return false;
    if (streets.length && !streets.includes(`${r.family}-${r.street}`)) return false;
    if (type && r.stockType !== type) return false;
    if (bulky === "1" && !r.isBulky) return false;
    if (bulky === "0" && r.isBulky) return false;
    if (dFrom && r.dateStr && r.dateStr < dFrom) return false;
    if (dTo && r.dateStr && r.dateStr > dTo) return false;
    if (iFrom && r.inboundStr && r.inboundStr < iFrom) return false;
    if (iTo && r.inboundStr && r.inboundStr > iTo) return false;
    if (q) {
      const hay = `${r.skuId} ${r.skuName} ${r.locId} ${r.family} ${r.street} ${r.batch} ${r.stockType}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  renderAll();
}

function clearFilters() {
  ["#fZone", "#fStreet"].forEach(id => Array.from($(id).options).forEach(o => o.selected = false));
  $("#fStockType").value = ""; $("#fBulky").value = ""; $("#fSearch").value = "";
  ["#fDateFrom", "#fDateTo", "#fInboundFrom", "#fInboundTo"].forEach(id => $(id).value = "");
  STATE.filtered = STATE.raw.slice();
  renderAll();
}

/* =====================================================================
   6) EVENTOS + INIT + AUTO-REFRESH
   ===================================================================== */
function wireEvents() {
  $("#btnApply").addEventListener("click", applyFilters);
  $("#btnClear").addEventListener("click", clearFilters);
  let t; $("#fSearch").addEventListener("input", () => { clearTimeout(t); t = setTimeout(applyFilters, 250); });
  $("#btnRefresh").addEventListener("click", () => refresh(true));

  // sidebar mobile
  const panel = $("#filtersPanel"), ov = $("#filtersOverlay");
  const open = () => { panel.classList.add("open"); ov.classList.add("show"); };
  const close = () => { panel.classList.remove("open"); ov.classList.remove("show"); };
  $("#btnOpenFilters").addEventListener("click", open);
  $("#btnCloseFilters").addEventListener("click", close);
  ov.addEventListener("click", close);
}

async function refresh(manual = false) {
  const btn = $("#btnRefresh"); btn.classList.add("spin");
  await loadData();
  buildFilterOptions();
  STATE.filtered = STATE.raw.slice();
  renderAll();
  $("#lastUpdate").textContent = "Atualizado " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  setLoader(false);
  setTimeout(() => btn.classList.remove("spin"), 600);
}

function startAutoRefresh() {
  if (STATE.refreshTimer) clearInterval(STATE.refreshTimer);
  const ms = Math.max(1, CONFIG.AUTO_REFRESH_MINUTES) * 60000;
  STATE.refreshTimer = setInterval(() => refresh(false), ms);
}

async function init() {
  wireEvents();
  await refresh(true);
  startAutoRefresh();
}

/* =====================================================================
   7) BASE DE DEMONSTRAÇÃO (renderiza sem planilha configurada)
   ===================================================================== */
function buildDemoData() {
  const rows = [];
  const today = new Date();
  const names = ["Fone Bluetooth TWS", "Carregador Turbo 30W", "Camiseta Algodão", "Caneca Cerâmica 350ml",
    "Mouse Gamer RGB", "Garrafa Térmica 1L", "Luminária LED", "Tênis Esportivo", "Mochila Notebook",
    "Smartwatch Fit", "Cabo USB-C 2m", "Teclado Mecânico", "Air Fryer 4L", "Ventilador de Mesa",
    "Kit Organizador", "Panela Antiaderente", "Power Bank 20000", "Suporte Celular", "Headset Gamer", "Echo Dot"];
  const familyStreets = {
    A2: { streets: 26, addrPerStreet: 6, baseFill: .55 },
    HV: { streets: 12, addrPerStreet: 5, baseFill: .60 },
    BL: { streets: 10, addrPerStreet: 5, baseFill: .65 },
    M2: { streets: 16, addrPerStreet: 5, baseFill: .50 },
  };
  const hsZones = ["HS2", "HS3", "HS4", "HS5", "HS6", "HS9", "HS10", "HS13", "HS15", "HS20", "HS21", "HS24"];
  let skuCounter = 1000;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  function emit(family, zoneRaw, locId, intensity) {
    const nSku = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < nSku; k++) {
      const id = "SKU" + (skuCounter++);
      const L = Math.round(rnd(80, 600)), W = Math.round(rnd(80, 500)), H = Math.round(rnd(50, 450));
      const bulky = (L * W * H > 6e7) ? Math.random() < .6 : Math.random() < .08;
      const cap = CAPACITY[family] ?? (family === "HS" ? 12 : 15);
      const qty = Math.max(1, Math.round(cap * intensity / nSku * rnd(.7, 1.3)));
      const inbAge = Math.floor(rnd(0, 220));
      const inbound = new Date(today.getTime() - inbAge * 86400000);
      const dateAge = Math.floor(rnd(0, 13));
      const date = new Date(today.getTime() - dateAge * 86400000);
      rows.push({
        date, dateStr: isoDate(date),
        skuId: id, skuName: pick(names),
        L, W, H, family, zoneRaw, locId,
        street: streetOf(family, locId),
        stockType: pick(["Normal", "Normal", "Normal", "Quarantine", "Damage"]),
        batch: "B" + Math.floor(rnd(1000, 9999)),
        inbound, inboundStr: isoDate(inbound),
        isBulky: bulky, qty,
        listingPrice: +rnd(20, 500).toFixed(2), unitCogs: +rnd(5, 200).toFixed(2),
        skuValue: 0,
        cubM3: (L * W * H * qty) / 1e9
      });
    }
  }

  // famílias numéricas
  for (const [fam, cfg] of Object.entries(familyStreets)) {
    for (let st = 1; st <= cfg.streets; st++) {
      const hot = Math.random() < .18 ? rnd(1.0, 1.25) : cfg.baseFill * rnd(.7, 1.3);
      for (let a = 1; a <= cfg.addrPerStreet; a++) {
        if (Math.random() < .12) continue; // alguns endereços vazios
        const loc = `BRFPE1-${fam}-${String(st).padStart(2, "0")}-${String(a).padStart(2, "0")}-1-${String(Math.floor(rnd(1, 300))).padStart(3, "0")}`;
        emit(fam, fam, loc, Math.min(1.3, hot));
      }
    }
  }
  // HS (pallets)
  for (const hz of hsZones) {
    const addr = 8 + Math.floor(rnd(0, 14));
    const baseFill = Math.random() < .2 ? rnd(.95, 1.15) : rnd(.45, .85);
    for (let a = 1; a <= addr; a++) {
      const loc = `BRFPE1-${hz}-${String(Math.floor(rnd(1, 30))).padStart(2, "0")}-${String(a).padStart(2, "0")}-${String(Math.floor(rnd(1, 999))).padStart(3, "0")}`;
      emit("HS", hz, loc, Math.min(1.2, baseFill * rnd(.8, 1.2)));
    }
  }
  // AV
  for (let a = 1; a <= 40; a++) {
    const loc = `BRFPE1-AV-${String(Math.floor(rnd(1, 8))).padStart(2, "0")}-${String(a).padStart(2, "0")}-1-${String(Math.floor(rnd(1, 200))).padStart(3, "0")}`;
    emit("AV", "AV", loc, rnd(.4, .9));
  }
  return rows;
}

/* GO */
document.addEventListener("DOMContentLoaded", init);
