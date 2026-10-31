"use strict";
// ---------- constants ----------
const INK_THRESHOLD = 215;          // luminance below this counts as drawn ink
const COL_MATCH = [150, 155, 160];  // gray (#969ba0) for matching linework
const COL_DIFF = [35, 124, 173];    // blue (#237cad); red (#ed4133) with "Ver diferencias en COLOR ROJO" (changed in place)
const COL_DIFF_BLUE = [35, 124, 173], COL_DIFF_RED = [237, 65, 51];
const LEGEND = [[COL_MATCH, "Coincide"], [COL_DIFF, "Diferencia"]];
const NO_MATCH = 20;                // below this % of matching linework, A and B are treated as different plans
const MAX_ZOOM = 32;                // screen px per overview px
const DETAIL_BUDGET = 14e6;         // max pixels of the sharp detail render
const HATCH_MIN_MM = 4;             // PDF: a filled area at least this long (on paper) counts as hatch
const TOL = 1;                      // px a line may shift without counting as a change
const RES = 4500;                   // long side of the comparison image, px
const PDF_RES = 12000;              // long side of the comparison in the downloaded PDF, px (redrawn from the plans in tiles)
const PDF_TILE = 2000;              // tile side for that redraw, px
const $ = (id) => document.getElementById(id);
const DPR = () => Math.min(2, window.devicePixelRatio || 1);

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const S = {
  A: null, B: null,             // {name, kind:'pdf'|'dxf', pdf, dxf, pages, page, scale | prims,bb,k,pad, text}
  rasterA: null, rasterB: null, // overview canvases (unaligned)
  frame: null,                  // {W,H}
  maskA: null,
  xf: null,                     // {mode:'auto'|'manual', m:[a,b,c,d,e,f]} maps B raster px -> frame px
  autoXf: null,
  bWarp: null,                  // aligned B canvas (overview)
  excl: [],                     // excluded rectangles, frame px
  neutral: [],                  // boxes of matching texts, frame px
  view: "diff",
  mixed: false,
  result: null,
  red: false,                   // "Ver diferencias en COLOR ROJO": off by default (differences in blue)
  hatch: true,                  // on by default; off: hatch (and dark filled areas in PDFs) with lines along their edge are left out; lone fills are compared
  annot: true,                  // annotation (axes, dimensions, texts, levels, section marks) is compared; off: not drawn nor compared
};

// ---------- small affine helpers ----------
const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
const apply = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
const scaleOf = (m) => Math.hypot(m[0], m[1]);
const I = [1, 0, 0, 1, 0, 0];
const inv = (m) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]; };

// ---------- file handling ----------
async function loadFile(k, file) {
  const msg = $("msg" + k); msg.hidden = true;
  showName(k, file.name);
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const buf = await file.arrayBuffer();
  try {
    if (ext === "dwg") throw new Error("El formato DWG no se puede leer en el navegador. Exporta el plano a PDF (Trazar → PDF) o a DXF desde tu programa CAD.");
    if (ext === "pdf" || isPdf(buf)) {
      if (!window.pdfjsLib) throw new Error("No se pudo cargar el lector de PDF. Revisa tu conexión y recarga la página.");
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise; // CVE-2024-4367 mitigation
      S[k] = { name: file.name, kind: "pdf", pdf, pages: pdf.numPages, page: 1, ocAnnot: [] };
      try {
        const g = (await pdf.getOptionalContentConfig()).getGroups() || {};
        for (const [id, grp] of Object.entries(g)) if (annotLayer(grp.name)) S[k].ocAnnot.push(id);
      } catch (e) { console.warn(e); }
    } else if (ext === "dxf") {
      const head = new TextDecoder("latin1").decode(buf.slice(0, 22));
      if (head.startsWith("AutoCAD Binary DXF")) throw new Error("Este DXF es binario. Expórtalo como DXF de texto (ASCII).");
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
      const P = window.DxfParser && (window.DxfParser.default || window.DxfParser.DxfParser || window.DxfParser);
      if (!P) throw new Error("No se pudo cargar el lector de DXF. Revisa tu conexión y recarga la página.");
      const parser = new P();
      try { parser.registerEntityHandler(HatchHandler); } catch (e) { console.warn(e); }
      const dxf = parser.parseSync(text);
      if (!dxf || !dxf.entities) throw new Error("No se pudo leer el DXF.");
      S[k] = { name: file.name, kind: "dxf", dxf, pages: 1, page: 1 };
    } else {
      throw new Error("Formato no reconocido. Usa PDF o DXF.");
    }
  } catch (e) {
    S[k] = null; resetView(); showName(k, file.name); // the previous result no longer applies
    msg.textContent = e.message || String(e); msg.hidden = false;
    showError(`${file.name}: ${e.message || e}`);
    return false;
  }
  refreshSlot(k);
  return true;
}
function refreshSlot(k) {
  const D = S[k], sel = $("page" + k);
  showName(k, D ? D.name : "");
  $("msg" + k).hidden = true;
  sel.innerHTML = "";
  if (D && D.pages > 1) {
    for (let i = 1; i <= D.pages; i++) sel.add(new Option("Página " + i, i));
    sel.value = D.page; sel.hidden = false;
  } else sel.hidden = true;
}
function showName(k, name) {
  const n = $("name" + k); n.textContent = name; n.hidden = !name; $("slot" + k).classList.toggle("has", !!name);
  $("pick" + k).textContent = S[k] ? "Cambiar archivo" : "Elegir archivo";
}
function isPdf(buf) { const b = new Uint8Array(buf.slice(0, 5)); return String.fromCharCode(...b) === "%PDF-"; }

for (const k of ["A", "B"]) {
  $("pick" + k).onclick = () => $("file" + k).click();
  $("file" + k).onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) await userLoad(k, f); };
  $("page" + k).onchange = (e) => { S[k].page = +e.target.value; S.excl = []; run({ rerender: true }); };
}

// ---------- drag and drop from a folder, anywhere on the page ----------
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
let dropTimer = 0;
function hideDrop() { $("drop").hidden = true; document.querySelectorAll(".dz").forEach((d) => d.classList.remove("over")); }
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); $("drop").hidden = false; });
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "copy";
  $("drop").hidden = false;
  const dz = e.target.closest ? e.target.closest(".dz") : null;
  document.querySelectorAll(".dz").forEach((d) => d.classList.toggle("over", d === dz));
  // dragover repeats while the pointer is over the page; when it stops, the drag left
  clearTimeout(dropTimer); dropTimer = setTimeout(hideDrop, 400);
});
window.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); clearTimeout(dropTimer);
  const dz = e.target.closest ? e.target.closest(".dz") : null;
  hideDrop();
  await takeFiles([...e.dataTransfer.files], dz ? dz.dataset.k : null);
});

// Two files: the first by name is A. One file: the slot it was dropped on, else the first free one.
async function takeFiles(files, k) {
  if (exporting) return;
  files = files.filter((f) => /\.(pdf|dxf|dwg)$/i.test(f.name));
  if (!files.length) { showError("Solo se pueden comparar archivos PDF o DXF."); return; }
  clearError();
  if (files.length >= 2) {
    files.sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" }));
    setBusy("Leyendo " + files[0].name + " y " + files[1].name + "…");
    await new Promise((r) => setTimeout(r, 30));
    const okA = await loadFile("A", files[0]), okB = await loadFile("B", files[1]);
    setBusy(null);
    if (okA && okB) newFiles(); else if (okA) waitFor("B"); else if (okB) waitFor("A");
    return;
  }
  if (!k) k = !S.A ? "A" : "B";
  await userLoad(k, files[0]);
}
$("fileBoth").onchange = async (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) await takeFiles(f, null); };
$("swap").onclick = () => {
  if (exporting || (!S.A && !S.B)) return;
  [S.A, S.B] = [S.B, S.A]; refreshSlot("A"); refreshSlot("B");
  if (!S.A || !S.B) { waitFor(S.A ? "B" : "A"); return; }
  if (!S.xf || !S.rasterA) { newFiles(); return; }
  // The same two plans the other way round: each is drawn as before (the drawing does not depend on
  // which one is A), so the alignment found or marked by hand still holds, inverted. Before v25 the
  // swap aligned again from scratch and lost a manual alignment.
  S.xf = { ...S.xf, m: inv(S.xf.m) }; if (S.autoXf) S.autoXf = inv(S.autoXf);
  S.excl = []; syncLoaded(); run({ rerender: true, keepAlign: true });
};
function newFiles() { S.excl = []; S.xf = null; S.forceShow = false; syncLoaded(); run({ rerender: true }); }
// on a phone the viewer and the Cambios card appear once both plans are loaded (or to show an error)
function syncLoaded() { document.querySelector(".app").classList.toggle("loaded", !!(S.A && S.B) || !!errKind); }

// Nothing is compared until both plans are loaded.
async function userLoad(k, file) {
  clearError();
  setBusy("Leyendo " + file.name + "…");
  await new Promise((r) => setTimeout(r, 30));
  const ok = await loadFile(k, file);
  setBusy(null);
  const o = k === "A" ? "B" : "A";
  if (ok && S.A && S.B) newFiles();
  else if (ok) waitFor(o);
}
function clearSlot(k) { S[k] = null; showName(k, ""); $("page" + k).hidden = true; $("msg" + k).hidden = true; }
function resetView() {
  runId++; cancelRenders(); detailId++; clearDetail(); setBusy(null);
  Object.assign(S, { result: null, rasterA: null, rasterB: null, xf: null, excl: [], running: false });
  main.content.hidden = true;
  $("dlPdf").disabled = $("dlDxf").disabled = true; $("dlHint").textContent = ""; $("alignBtn").disabled = false;
  $("pct").textContent = "–"; $("pctLbl").textContent = preLabel(); $("pctLbl").classList.add("pre"); $("alignBtn").hidden = true; $("resultSec").hidden = true;
  setStatus(""); syncLoaded();
}
function preLabel() { return "Los cambios aparecerán en color " + (S.red ? "rojo" : "azul"); }
function waitFor(k) { resetView(); showHome(`Plano ${k === "A" ? "B" : "A"} listo. Ahora carga el plano ${k}.`); }

// ---------- loica: welcome and error ----------
// The welcome loica sits in the viewer while a plan is missing. Errors (a file that cannot be read,
// a comparison that fails, or A and B that do not match) show the error loica for 10 s, then go back.
let errTimer = 0, errTick = 0, errKind = null;
function showHome(msg) {
  $("emptyMsg").textContent = msg || ""; $("emptyMsg").hidden = !msg;
  if (!errKind) $("empty").hidden = false;
}
function showError(msg, kind = "error") {
  clearTimeout(errTimer); clearInterval(errTick);
  errKind = kind;
  $("errMsg").textContent = msg; $("errBtns").hidden = kind !== "nomatch";
  $("empty").hidden = true; $("errorView").hidden = false; document.querySelector(".credit").style.visibility = "hidden"; syncLoaded(); // on a phone it would sit on the countdown
  let left = 10;
  const tick = () => { $("errCount").textContent = `Volviendo al inicio en ${left} s.`; };
  tick(); errTick = setInterval(() => { left = Math.max(1, left - 1); tick(); }, 1000);
  errTimer = setTimeout(backHome, 10000);
}
function clearError() { clearTimeout(errTimer); clearInterval(errTick); errKind = null; $("errorView").hidden = true; document.querySelector(".credit").style.visibility = ""; syncLoaded(); }
// after an error: keep a plan that loaded fine and wait for the other; otherwise start over
function backHome() {
  clearError();
  for (const k of ["A", "B"]) if (!S[k]) clearSlot(k);
  if (S.A && S.B) { clearSlot("A"); clearSlot("B"); }
  if (S.A) waitFor("B"); else if (S.B) waitFor("A"); else { resetView(); showHome(""); }
}
$("loicaBtn").onclick = () => $("fileBoth").click();
// The sign shows one message at a time: BIENVENIDO for 4 s, then ARRASTRA AQUÍ 10 s / TE ESTOY ESPERANDO 5 s.
// Each time the welcome screen comes back, a fresh copy of the drawing starts the head movement from zero.
const loicaTpl = $("loicaBtn").querySelector("svg").cloneNode(true);
let loicaT0 = 0, loicaTick = 0, loicaOn = false;
function loicaMsg() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "drag";
  const t = (performance.now() - loicaT0) / 1000;
  return t < 4 ? "welcome" : (t - 4) % 15 < 10 ? "drag" : "wait";
}
function loicaSync() {
  const on = !$("empty").hidden;
  if (on === loicaOn) return;
  loicaOn = on; clearInterval(loicaTick);
  if (!on) return;
  const svg = loicaTpl.cloneNode(true);
  $("loicaBtn").querySelector("svg").replaceWith(svg);
  loicaT0 = performance.now();
  const set = () => { const m = loicaMsg(); if (svg.getAttribute("data-msg") !== m) svg.setAttribute("data-msg", m); };
  set(); loicaTick = setInterval(set, 200);
}
new MutationObserver(loicaSync).observe($("empty"), { attributes: true, attributeFilter: ["hidden"] });

// Hidden detail: a click on the golondrina's head (.golondrina-head-hit) plays its song once, about 2 s, with the beak
// moving (class is-singing). Clicks while it sings are ignored. The sign and the rest keep opening the file picker.
const SONG = "audio/golondrina-canto.mp3";
// The same song inside the page (the original file): it plays when audio/ is not next to the page, for
// example the HTML opened or uploaded on its own, or a host that does not serve the .mp3.
const SONG_DATA = "data:audio/mpeg;base64,SUQzAwAAAABDIVRZRVIAAAAGAAAAMjAyNgBUREFUAAAABgAAADMwMTAAVElNRQAAAAYAAAAxMDAyAFBSSVYAABlnAABYTVAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNi4wLWMwMDIgNzkuMTY0MzYwLCAyMDIwLzAyLzEzLTAxOjA3OjIyICAgICAgICAiPgogPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4KICA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIgogICAgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iCiAgICB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIgogICAgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiCiAgICB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iCiAgICB4bWxuczpjcmVhdG9yQXRvbT0iaHR0cDovL25zLmFkb2JlLmNvbS9jcmVhdG9yQXRvbS8xLjAvIgogICAgeG1sbnM6eG1wRE09Imh0dHA6Ly9ucy5hZG9iZS5jb20veG1wLzEuMC9EeW5hbWljTWVkaWEvIgogICAgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIgogICB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjMwMTYwNDJhLWMzYWMtZWI0OC1iMDQ0LTNhMGRlZTJkOTc4NyIKICAgeG1wTU06RG9jdW1lbnRJRD0iMmViNTNhOWUtZDg3NC1hOTM1LWFhYTEtMWM0ZDAwMDAwMDUzIgogICB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6ZGU1Nzk4NzctOGU4OS1lMjQ3LWI2ZGMtOTcxMDk0YmRlMzEzIgogICB4bXA6TWV0YWRhdGFEYXRlPSIyMDI2LTEwLTMwVDEwOjAyOjM0LTAzOjAwIgogICB4bXA6TW9kaWZ5RGF0ZT0iMjAyNi0xMC0zMFQxMDowMjozNC0wMzowMCIKICAgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQcmVtaWVyZSBQcm8gMjAyMC4wIChXaW5kb3dzKSIKICAgeG1wOkNyZWF0ZURhdGU9IjIwMjYtMTAtMzBUMTA6MDI6MDQtMDM6MDAiCiAgIHhtcERNOmF1ZGlvU2FtcGxlUmF0ZT0iLTEiCiAgIHhtcERNOmF1ZGlvU2FtcGxlVHlwZT0iMTZJbnQiCiAgIHhtcERNOmF1ZGlvQ2hhbm5lbFR5cGU9IlN0ZXJlbyIKICAgeG1wRE06c3RhcnRUaW1lU2NhbGU9IjI1IgogICB4bXBETTpzdGFydFRpbWVTYW1wbGVTaXplPSIxIgogICBkYzpmb3JtYXQ9Ik1QMyI+CiAgIDx4bXBNTTpIaXN0b3J5PgogICAgPHJkZjpTZXE+CiAgICAgPHJkZjpsaQogICAgICBzdEV2dDphY3Rpb249InNhdmVkIgogICAgICBzdEV2dDppbnN0YW5jZUlEPSI5OWExODNiMi0zNmYwLWU4NWItOTA1YS1jMTE1MDAwMDAwODAiCiAgICAgIHN0RXZ0OndoZW49IjIwMjYtMTAtMzBUMTA6MDI6MzQtMDM6MDAiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFByZW1pZXJlIFBybyAyMDIwLjAgKFdpbmRvd3MpIgogICAgICBzdEV2dDpjaGFuZ2VkPSIvIi8+CiAgICAgPHJkZjpsaQogICAgICBzdEV2dDphY3Rpb249ImNyZWF0ZWQiCiAgICAgIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6YzllYWRhMzUtMWEzMC1iMjQ1LWJlZDQtOWU2ZTI0NzlkMzIyIgogICAgICBzdEV2dDp3aGVuPSIyMDI2LTEwLTMwVDEwOjAyOjM0LTAzOjAwIgogICAgICBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQcmVtaWVyZSBQcm8gMjAyMC4wIChXaW5kb3dzKSIvPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo5YzRiZmNiYS1jNjQ5LTI1NGUtYWU2My1mYzY0YWRhY2Y2ZTkiCiAgICAgIHN0RXZ0OndoZW49IjIwMjYtMTAtMzBUMTA6MDI6MzQtMDM6MDAiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFByZW1pZXJlIFBybyAyMDIwLjAgKFdpbmRvd3MpIgogICAgICBzdEV2dDpjaGFuZ2VkPSIvIi8+CiAgICAgPHJkZjpsaQogICAgICBzdEV2dDphY3Rpb249InNhdmVkIgogICAgICBzdEV2dDppbnN0YW5jZUlEPSJ4bXAuaWlkOjMwMTYwNDJhLWMzYWMtZWI0OC1iMDQ0LTNhMGRlZTJkOTc4NyIKICAgICAgc3RFdnQ6d2hlbj0iMjAyNi0xMC0zMFQxMDowMjozNC0wMzowMCIKICAgICAgc3RFdnQ6c29mdHdhcmVBZ2VudD0iQWRvYmUgUHJlbWllcmUgUHJvIDIwMjAuMCAoV2luZG93cykiCiAgICAgIHN0RXZ0OmNoYW5nZWQ9Ii9tZXRhZGF0YSIvPgogICAgPC9yZGY6U2VxPgogICA8L3htcE1NOkhpc3Rvcnk+CiAgIDx4bXBNTTpJbmdyZWRpZW50cz4KICAgIDxyZGY6QmFnPgogICAgIDxyZGY6bGkKICAgICAgc3RSZWY6aW5zdGFuY2VJRD0iZWFjMDhlMmMtNjJjOC1hNzYxLTZmY2YtNTY4ZTAwMDAwMDg0IgogICAgICBzdFJlZjpkb2N1bWVudElEPSIxMWE4NDk3Zi04MDc3LTA3YzYtMmQyZi1lMDVhMDAwMDAwNTciCiAgICAgIHN0UmVmOmZyb21QYXJ0PSJ0aW1lOjExNTgzMTI5NjAwMDBmMjU0MDE2MDAwMDAwZDUxODE5MjY0MDAwMGYyNTQwMTYwMDAwMDAiCiAgICAgIHN0UmVmOnRvUGFydD0idGltZTowZDUxODE5MjY0MDAwMGYyNTQwMTYwMDAwMDAiCiAgICAgIHN0UmVmOmZpbGVQYXRoPSJHb2xvbmRyaW5hIENoaWxlbmEubXAzIgogICAgICBzdFJlZjptYXNrTWFya2Vycz0iTm9uZSIvPgogICAgPC9yZGY6QmFnPgogICA8L3htcE1NOkluZ3JlZGllbnRzPgogICA8eG1wTU06UGFudHJ5PgogICAgPHJkZjpCYWc+CiAgICAgPHJkZjpsaT4KICAgICAgPHJkZjpEZXNjcmlwdGlvbgogICAgICAgeG1wTU06SW5zdGFuY2VJRD0iZWFjMDhlMmMtNjJjOC1hNzYxLTZmY2YtNTY4ZTAwMDAwMDg0IgogICAgICAgeG1wTU06RG9jdW1lbnRJRD0iMTFhODQ5N2YtODA3Ny0wN2M2LTJkMmYtZTA1YTAwMDAwMDU3IgogICAgICAgeG1wTU06T3JpZ2luYWxEb2N1bWVudElEPSJ4bXAuZGlkOmNlYTVlMDRkLTliMzEtNjc0Zi1hZjRhLTc0NWU5NDA1ODhlOCIKICAgICAgIHhtcDpNZXRhZGF0YURhdGU9IjIwMjYtMTAtMzBUMDk6NTg6NDgtMDM6MDAiCiAgICAgICB4bXA6TW9kaWZ5RGF0ZT0iMjAyNi0xMC0zMFQwOTo1ODo0OC0wMzowMCI+CiAgICAgIDx4bXBNTTpIaXN0b3J5PgogICAgICAgPHJkZjpTZXE+CiAgICAgICAgPHJkZjpsaQogICAgICAgICBzdEV2dDphY3Rpb249InNhdmVkIgogICAgICAgICBzdEV2dDppbnN0YW5jZUlEPSJlYWMwOGUyYy02MmM4LWE3NjEtNmZjZi01NjhlMDAwMDAwODQiCiAgICAgICAgIHN0RXZ0OndoZW49IjIwMjYtMTAtMzBUMDk6NTg6NDgtMDM6MDAiCiAgICAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFByZW1pZXJlIFBybyAyMDIwLjAgKFdpbmRvd3MpIgogICAgICAgICBzdEV2dDpjaGFuZ2VkPSIvIi8+CiAgICAgICA8L3JkZjpTZXE+CiAgICAgIDwveG1wTU06SGlzdG9yeT4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgICAgPC9yZGY6bGk+CiAgICA8L3JkZjpCYWc+CiAgIDwveG1wTU06UGFudHJ5PgogICA8eG1wTU06RGVyaXZlZEZyb20KICAgIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6YzllYWRhMzUtMWEzMC1iMjQ1LWJlZDQtOWU2ZTI0NzlkMzIyIgogICAgc3RSZWY6ZG9jdW1lbnRJRD0ieG1wLmRpZDpjOWVhZGEzNS0xYTMwLWIyNDUtYmVkNC05ZTZlMjQ3OWQzMjIiCiAgICBzdFJlZjpvcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6YzllYWRhMzUtMWEzMC1iMjQ1LWJlZDQtOWU2ZTI0NzlkMzIyIi8+CiAgIDxjcmVhdG9yQXRvbTp3aW5kb3dzQXRvbQogICAgY3JlYXRvckF0b206ZXh0ZW5zaW9uPSIucHJwcm9qIgogICAgY3JlYXRvckF0b206aW52b2NhdGlvbkZsYWdzPSIvTCIKICAgIGNyZWF0b3JBdG9tOnVuY1Byb2plY3RQYXRoPSJcXD9cRDpcUEVSU09OQUxFU1xNSU5BUlRcMjAyNVxMT1MgVVNBU1RFXE1BU1RFUklaQUNJT04gVk9MVU1FTiBMT1MgVVNBU1RFIE5VTkNBIE1BU09DVFVCUklTTU8ucHJwcm9qIi8+CiAgIDxjcmVhdG9yQXRvbTptYWNBdG9tCiAgICBjcmVhdG9yQXRvbTphcHBsaWNhdGlvbkNvZGU9IjEzNDc0NDk0NTUiCiAgICBjcmVhdG9yQXRvbTppbnZvY2F0aW9uQXBwbGVFdmVudD0iMTEyOTQ2ODAxOCIvPgogICA8eG1wRE06cHJvamVjdFJlZgogICAgeG1wRE06dHlwZT0ibW92aWUiLz4KICAgPHhtcERNOmR1cmF0aW9uCiAgICB4bXBETTp2YWx1ZT0iNjEiCiAgICB4bXBETTpzY2FsZT0iMTAwMS8zMDAwMCIvPgogICA8eG1wRE06c3RhcnRUaW1lY29kZQogICAgeG1wRE06dGltZUZvcm1hdD0iMjk5N0Ryb3BUaW1lY29kZSIKICAgIHhtcERNOnRpbWVWYWx1ZT0iMDA7MDA7MDA7MDAiLz4KICAgPHhtcERNOmFsdFRpbWVjb2RlCiAgICB4bXBETTp0aW1lVmFsdWU9IjAwOzAwOzAwOzAwIgogICAgeG1wRE06dGltZUZvcm1hdD0iMjk5N0Ryb3BUaW1lY29kZSIvPgogIDwvcmRmOkRlc2NyaXB0aW9uPgogPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgIAo8P3hwYWNrZXQgZW5kPSJ3Ij8+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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6h5K4kv/+6kDsMgQLhpjHPqoUWmklJJJJG2gYDkSJb3EO5mSgmZsC3xFOGMQoXNzCqL2pDnC0iSnUezSiz+HSbLAd71Ip8gI4ShMkaqGuzKEeHpIU4mkGkZl4o8cI9KJ89DKVxlK1uaFccT9HPHFPatE92Jsh3cm5vkjvFZHfd9BgS2tJvwg6Gyg5wXMkAaBs6LigCK3ixaG16xVH+2Gsf9YQA11SAHz8muNdheXK4xX4UKFcxhZBOR5oCGB9AHlDRKj+ZVU//6fsC242k1VSgFglrq6k+gMMiisGDiQImdLiRSv//uQYMWABKE6y1HvetAlhBmcBCNJEeDLKae960CfjiVkEIklV7IBjkd0RbVaAIJcWHkVYYdhgcOQI/eVZ4WRZMqiUMqZhRCFxCdWMmMo3b5XszKEYGMQUnKoVZwNulcX6KeyiP1iQp23q1sfzvV02vW5h3EzBiO8b3B1vFq0tuuLWt8b9dfWfnT6JaoFMrjQCQpU9bthZbEKDv////////////////////////////////////////////////gHVX1SAf5UHXVuI8d+8xTxUq0iAQUovEi2qjd/et9b0f/+5pvBqIKO7sFFb1//15qlXAtokgCj6Vo6lUyOlQ8gdIAElVmnt6a480FMx/V6q+onZmAhTiYxakwE3AolP9b///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////uQYMuABaU6xmM4etAu47j5HMZIRfyDGQYwaQAGAGMAAAAE//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////uQQP+AC+gAS4AAAAgAAAlwAAABAAABLgAAACAAACXAAAAE//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//uQQP+AC+gAS4AAAAgAAAlwAAABAAABLgAAACAAACXAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVEFHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMjAyNgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let song = null, singing = false, songInPage = false;
function stopSong() {
  singing = false;
  const svg = $("loicaBtn").querySelector("svg"); if (svg) svg.classList.remove("is-singing");
  if (song) { song.pause(); song.currentTime = 0; }
}
const markSinging = () => { if (singing) $("loicaBtn").querySelector("svg").classList.add("is-singing"); };
// loaded with the page, so that a missing file is known (and replaced) before the first click
function songAudio() {
  if (song) return song;
  song = new Audio(SONG); song.preload = "auto"; song.volume = 0.6; song.onended = stopSong;
  song.onerror = () => {
    if (songInPage) { stopSong(); return; }
    songInPage = true; song.src = SONG_DATA; song.load();
    if (singing) song.play().then(markSinging).catch(stopSong);
  };
  return song;
}
songAudio();
$("loicaBtn").addEventListener("click", (e) => {
  if (!(e.target.closest && e.target.closest(".golondrina-head-hit"))) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (singing) return;
  singing = true;
  const a = songAudio(); a.currentTime = 0;
  // a file that cannot be read rejects here and fires "error", which switches to the copy in the page
  a.play().then(markSinging).catch((err) => { if (!(err && err.name === "NotSupportedError" && !songInPage)) stopSong(); });
}, true);
new MutationObserver(() => { if ($("empty").hidden && singing) stopSong(); }).observe($("empty"), { attributes: true, attributeFilter: ["hidden"] });

// ---------- HATCH entities (dxf-parser 1.1.2 skips them) ----------
// Boundary loops and pattern lines, in the entity's own coordinates (OCS).
class HatchHandler {
  constructor() { this.ForEntityName = "HATCH"; }
  parseEntity(sc, g) {
    const t = [];
    for (g = sc.next(); !sc.isEOF() && g.code !== 0; g = sc.next()) t.push([g.code, g.value]);
    return parseHatch(t);
  }
}
function parseHatch(t) {
  const e = { type: "HATCH", loops: [], lines: [], solid: false };
  let i = 0;
  const at = (c) => i < t.length && t[i][0] === c;
  const val = () => t[i++][1];
  while (i < t.length && !at(91)) {
    const [c, v] = t[i++];
    if (c === 8) e.layer = v; else if (c === 60) e.visible = v === 0; else if (c === 67) e.inPaperSpace = v !== 0;
    else if (c === 2) e.pattern = v; else if (c === 70) e.solid = v === 1; else if (c === 230) e.extrusionDirectionZ = v;
  }
  if (i >= t.length) return e;
  const nLoops = val();
  for (let L = 0; L < nLoops && i < t.length; L++) {
    while (i < t.length && !at(92)) i++;
    if (i >= t.length) break;
    const flag = val();
    if (flag & 2) { // polyline loop: 72 has bulge, 73 closed, 93 count, then 10/20/[42]
      while (i < t.length && !at(93)) i++;
      const nv = i < t.length ? val() : 0, vs = [];
      for (let k = 0; k < nv && at(10); k++) { const x = val(), y = at(20) ? val() : 0, b = at(42) ? val() : 0; vs.push({ x, y, bulge: b }); }
      e.loops.push({ poly: vs });
    } else { // edge loop: lines, arcs, elliptic arcs and splines
      const ne = at(93) ? val() : 0, edges = [];
      for (let k = 0; k < ne && at(72); k++) {
        const type = val();
        if (type === 4) {
          const ed = { type, deg: 3, knots: [], cp: [] };
          while (i < t.length && [94, 73, 74, 95, 96].includes(t[i][0])) { const [c, v] = t[i++]; if (c === 94) ed.deg = v; }
          while (at(40)) ed.knots.push(val());
          while (at(10)) { const x = val(), y = at(20) ? val() : 0; if (at(42)) i++; ed.cp.push({ x, y }); }
          if (at(97)) { // fit data, unless this 97 already counts the loop's source objects
            const save = i, n = val();
            if (at(11) || at(12) || (n === 0 && at(97))) { while (at(11) || at(21) || at(12) || at(22) || at(13) || at(23)) i++; } else i = save;
          }
          edges.push(ed);
        } else {
          const m = {};
          while (i < t.length && ![72, 97, 92, 75].includes(t[i][0])) { const [c, v] = t[i++]; m[c] = v; }
          edges.push({ type, m });
        }
      }
      e.loops.push({ edges });
    }
    if (at(97)) { const n = val(); for (let k = 0; k < n && at(330); k++) i++; }
  }
  while (i < t.length) {
    const [c, v] = t[i];
    if (c === 78) { // pattern lines: angle, base point, offset, dashes (already scaled and rotated)
      i++;
      for (let q = 0; q < v && at(53); q++) {
        const ln = { a: val() };
        ln.bx = at(43) ? val() : 0; ln.by = at(44) ? val() : 0; ln.ox = at(45) ? val() : 0; ln.oy = at(46) ? val() : 0;
        const nd = at(79) ? val() : 0; ln.d = [];
        for (let r = 0; r < nd && at(49); r++) ln.d.push(val());
        e.lines.push(ln);
      }
      continue;
    }
    if (c === 450 && v === 1) e.solid = true; // gradient fills are drawn as solid
    i++;
  }
  return e;
}

// ---------- annotation elements ("Elementos de anotación" switch) ----------
// What is not part of the drawn building: axes and their bubbles, dimensions, texts, level marks,
// section and elevation marks, tags. Switched off, they are neither drawn nor compared.
// By name: DXF layers, DXF blocks and PDF layers (the layer's own name, also inside a bound xref "XREF$0$COTAS").
const ANNOT_WORDS = new Set(("eje ejes axis axes grid grids grilla grillas iden cota cotas acotacion acotaciones dim dims dimension dimensions dimensiones " +
  "texto textos text texts anno anot anota anotacion anotaciones annotation annotations nota notas note notes nplt " +
  "levl npt symb simb simbolo simbolos simbologia symbol symbols tag tags etiqueta etiquetas").split(" "));
const LEVEL_WORDS = new Set("nivel niveles level levels".split(" ")); // only in names without numbers ("NIVEL 1" holds a floor's walls)
const CUT_WORDS = new Set("corte cortes seccion secciones section sections sect elev elevacion elevaciones elevation elevations".split(" "));
const MARK_WORDS = new Set("linea lineas line lines marca marcas mark marks simb symb simbolo head cabeza tail flecha".split(" "));
const BLOCK_WORDS = new Set("level levels grid grids nivel niveles npt eje ejes burbuja burbujas cota cotas tag tags etiqueta etiquetas callout spot".split(" "));
const AXIS_LT = /grid|eje/i; // DXF linetypes of axes
const nameWords = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
function annotLayer(name) {
  const s = String(name || "").split("$0$").pop(), w = nameWords(s);
  if (!w.length) return false;
  if (w.some((x) => ANNOT_WORDS.has(x))) return true;
  if (!/\d/.test(s) && w.some((x) => LEVEL_WORDS.has(x))) return true;
  // "CORTES" alone holds the section lines and heads; "MURO CORTE" holds the cut walls
  if (w.every((x) => CUT_WORDS.has(x))) return true;
  return w.some((x) => CUT_WORDS.has(x)) && w.some((x) => MARK_WORDS.has(x));
}
// Revit names blocks "Family - Type-<id>-<view>"; the view ("NIVEL PISO 3") says nothing of the block
function annotBlock(name) {
  const s = String(name || "").replace(/-V?\d+-(?!.*-V?\d+-).*$/, ""), w = nameWords(s);
  if (w.some((x) => BLOCK_WORDS.has(x))) return true;
  return w.some((x) => CUT_WORDS.has(x)) && w.some((x) => MARK_WORDS.has(x));
}

// PDFs without layers: annotation is told apart by its shape around the texts.
// pdf.js builds each path between two beginPath() calls and then strokes or fills it. Paths are numbered
// in that order and their subpaths (each moveTo or rect) by place: the same numbers on every render of a
// page with the same layers hidden, at any zoom.
const TAP = ["beginPath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo", "rect", "closePath", "stroke", "fill"];
function untap(ctx) { if (ctx.__tap) { for (const [k, f] of ctx.__tap) { if (f) ctx[k] = f; else delete ctx[k]; } ctx.__tap = null; } }
function tap(ctx, hooks) {
  untap(ctx);
  const saved = [];
  for (const k of TAP) {
    if (!hooks[k]) continue;
    const own = Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : null, inner = ctx[k], h = hooks[k];
    saved.push([k, own]);
    ctx[k] = function (...a) { return h.call(this, inner, a); };
  }
  ctx.__tap = saved;
}
// Record every painted path of a render: [{pid, subs:[{pts, closed}], s, f, lw, col, dash}], canvas px.
function tapRecord(ctx, out) {
  let pid = 0, subs = [], cur = null, t = null, last = null;
  const dev = (x, y) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  const start = (c, x, y) => { t = c.getTransform(); cur = { pts: [dev(x, y)], closed: false }; subs.push(cur); };
  const paint = (c, kind) => {
    if (!subs.length) return;
    if (last && last.pid === pid) { last[kind] = true; if (kind === "s") { last.col = c.strokeStyle; last.lw = lwOf(c); last.dash = c.getLineDash().length > 0; } return; }
    last = { pid, subs, s: kind === "s", f: kind === "f", lw: kind === "s" ? lwOf(c) : 0, col: kind === "s" ? c.strokeStyle : c.fillStyle, dash: kind === "s" && c.getLineDash().length > 0, prim: c.__prim };
    out.push(last);
  };
  const lwOf = (c) => { const m = c.getTransform(); return c.lineWidth * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); };
  tap(ctx, {
    beginPath(inner, a) { pid++; subs = []; cur = null; return inner.apply(this, a); },
    moveTo(inner, a) { start(this, a[0], a[1]); return inner.apply(this, a); },
    lineTo(inner, a) { if (cur) cur.pts.push(dev(a[0], a[1])); else start(this, a[0], a[1]); return inner.apply(this, a); },
    bezierCurveTo(inner, a) {
      if (cur) {
        const [px, py] = cur.pts[cur.pts.length - 1], c1 = dev(a[0], a[1]), c2 = dev(a[2], a[3]), e = dev(a[4], a[5]);
        for (let i = 1; i <= 8; i++) { const u = i / 8, v = 1 - u; cur.pts.push([v * v * v * px + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0], v * v * v * py + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1]]); }
        cur.curve = true;
      }
      return inner.apply(this, a);
    },
    quadraticCurveTo(inner, a) { if (cur) { cur.pts.push(dev(a[2], a[3])); cur.curve = true; } return inner.apply(this, a); },
    rect(inner, a) {
      const [x, y, w, h] = a; t = this.getTransform();
      subs.push({ pts: [dev(x, y), dev(x + w, y), dev(x + w, y + h), dev(x, y + h), dev(x, y)], closed: true }); cur = null;
      return inner.apply(this, a);
    },
    closePath(inner, a) { if (cur) cur.closed = true; return inner.apply(this, a); },
    stroke(inner, a) { if (!(a[0] instanceof Path2D)) paint(this, "s"); return inner.apply(this, a); },
    fill(inner, a) { if (!(a[0] instanceof Path2D)) paint(this, "f"); return inner.apply(this, a); },
  });
}
// Leave out the marked subpaths (marks: pid -> Set of subpath numbers) of a render.
// A path with some marked subpaths is built again, at paint time, with the others only.
function tapFilter(ctx, marks) {
  const P = CanvasRenderingContext2D.prototype;
  let pid = 0, set = null, buf = null, cur = null, t = null;
  const dev = (x, y) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  const start = (c, x, y) => { t = c.getTransform(); cur = [["M", ...dev(x, y)]]; buf.push(cur); };
  // false: nothing of the path is left to paint
  const rebuild = (c) => {
    const keep = buf.filter((s, i) => !set.has(i)); if (!keep.length) return false;
    if (keep.length === buf.length) return true;
    const m = c.getTransform().invertSelf(), L = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    P.beginPath.call(c);
    for (const s of keep) for (const o of s) {
      if (o[0] === "M") P.moveTo.call(c, ...L(o[1], o[2]));
      else if (o[0] === "L") P.lineTo.call(c, ...L(o[1], o[2]));
      else if (o[0] === "C") P.bezierCurveTo.call(c, ...L(o[1], o[2]), ...L(o[3], o[4]), ...L(o[5], o[6]));
      else if (o[0] === "Q") P.quadraticCurveTo.call(c, ...L(o[1], o[2]), ...L(o[3], o[4]));
      else P.closePath.call(c);
    }
    return true;
  };
  tap(ctx, {
    beginPath(inner, a) { pid++; set = marks.get(pid) || null; buf = set ? [] : null; cur = null; return inner.apply(this, a); },
    moveTo(inner, a) { if (buf) start(this, a[0], a[1]); return inner.apply(this, a); },
    lineTo(inner, a) { if (buf) { if (cur) cur.push(["L", ...dev(a[0], a[1])]); else start(this, a[0], a[1]); } return inner.apply(this, a); },
    bezierCurveTo(inner, a) { if (buf && cur) cur.push(["C", ...dev(a[0], a[1]), ...dev(a[2], a[3]), ...dev(a[4], a[5])]); return inner.apply(this, a); },
    quadraticCurveTo(inner, a) { if (buf && cur) cur.push(["Q", ...dev(a[0], a[1]), ...dev(a[2], a[3])]); return inner.apply(this, a); },
    rect(inner, a) {
      if (buf) { const [x, y, w, h] = a; t = this.getTransform(); buf.push([["M", ...dev(x, y)], ["L", ...dev(x + w, y)], ["L", ...dev(x + w, y + h)], ["L", ...dev(x, y + h)], ["Z"]]); cur = null; }
      return inner.apply(this, a);
    },
    closePath(inner, a) { if (buf && cur) cur.push(["Z"]); return inner.apply(this, a); },
    stroke(inner, a) { if (buf && !(a[0] instanceof Path2D) && !rebuild(this)) return; return inner.apply(this, a); },
    fill(inner, a) { if (buf && !(a[0] instanceof Path2D) && !rebuild(this)) return; return inner.apply(this, a); },
  });
}

// Annotation of a PDF page without layers for it, found once per page and scale (overview px).
// oc: the layers hidden in the render, so paths are numbered as in the render.
// A canvas of 8 x 8 px that tells pdf.js it has the page's size: pdf.js leaves out fills it believes
// fall outside the canvas, and the paths are only recorded, not drawn.
function tinyCanvas(vp) {
  const c = document.createElement("canvas"); c.width = c.height = 8;
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  Object.defineProperty(c, "width", { get: () => W, set: () => {} }); Object.defineProperty(c, "height", { get: () => H, set: () => {} });
  return c;
}
// DXF lines on drawing layers that still are annotation (a level mark drawn with lines beside its text):
// found by the same shapes as in a PDF, on the overview. Marked primitives get "as".
function dxfAnnots(D) {
  const key = D.prims.length + "|" + D.k + "|" + D.pad + "|" + D.bb.join(",");
  if (D.annot && D.annot.key === key && D.annot.prims === D.prims) return D.annot; // a redraw builds new primitives
  const c = tinyCanvas({ width: D.W, height: D.H }), ctx = c.getContext("2d"), paths = [], texts = [];
  ctx.fillText = ctx.strokeText = () => {};
  for (const p of D.prims) p.as = false;
  tapRecord(ctx, paths);
  try { drawPrims(ctx, D, I, texts, false, true, true); } finally { untap(ctx); }
  // the layers already give the dimensions, axes, tags and their bubbles: look only for level marks drawn on
  // other layers (height marks, level triangles) and the lines that start at them
  const r = annotFind(paths, texts, false, { pre: (s) => !!(s.p.prim && s.p.prim.an), noDims: true, levelsOnly: true });
  for (const P of paths) {
    const set = r.marks.get(P.pid), q = P.prim;
    if (set && q && !q.an && (q.t === "p" || (q.t === "h" && q.solid)) && set.size >= P.subs.length) q.as = true;
  }
  D.annot = { key, prims: D.prims, n: r.n, kinds: r.kinds };
  return D.annot;
}
// A DXF hatch exploded into lines (LINE entities, no HATCH): the same families of parallel lines as in a PDF.
// A DXF has no paper scale: the overview (about 4500 px across) is read as a sheet about a meter wide.
const DXF_PX_PER_MM = 4.5;
function dxfHatch(D) {
  const key = D.prims.length + "|" + D.k + "|" + D.pad + "|" + D.bb.join(",");
  if (D.hl && D.hl.key === key && D.hl.prims === D.prims) return D.hl;
  const c = tinyCanvas({ width: D.W, height: D.H }), ctx = c.getContext("2d"), paths = [];
  ctx.fillText = ctx.strokeText = () => {};
  for (const p of D.prims) p.hl = false;
  tapRecord(ctx, paths);
  try { drawPrims(ctx, D, I, null, false, true, true); } finally { untap(ctx); }
  const r = lineHatch(paths, DXF_PX_PER_MM);
  let n = 0;
  for (const P of paths) { const set = r.marks.get(P.pid), q = P.prim; if (set && q && q.t === "p" && !q.fill && set.size >= P.subs.length) { q.hl = true; n++; } }
  D.hl = { key, prims: D.prims, n };
  return D.hl;
}
// The page's paths as pdf.js draws them, recorded once per set of hidden layers (the path numbers
// depend on it): what pdfAnnots and pdfHatch read.
async function pdfRecord(D, oc, hidden) {
  const key = D.page + "|" + D.scale + "|" + hidden;
  if (D.rec && D.rec.key === key) return D.rec;
  const page = await D.pdf.getPage(D.page), vp = page.getViewport({ scale: D.scale });
  const c = tinyCanvas(vp), ctx = c.getContext("2d"), paths = [];
  ctx.fillText = ctx.strokeText = () => {};
  tapRecord(ctx, paths);
  const task = page.render({ canvasContext: ctx, viewport: vp, optionalContentConfigPromise: oc });
  liveTasks.push(task);
  try { await task.promise; } finally { liveTasks = liveTasks.filter((t) => t !== task); untap(ctx); }
  D.rec = { key, paths, annot: null, hatch: null };
  return D.rec;
}
async function pdfAnnots(D, oc, hidden = "annot") {
  const R = await pdfRecord(D, oc, hidden);
  if (!R.annot) {
    let texts = [];
    try { texts = await pdfTexts(D); } catch {}
    const r = annotFind(R.paths, texts);
    R.annot = { marks: r.marks, n: r.n, kinds: r.kinds };
  }
  D.annot = R.annot;
  return R.annot;
}
async function pdfHatch(D, oc, hidden) {
  const R = await pdfRecord(D, oc, hidden);
  if (!R.hatch) R.hatch = lineHatch(R.paths, D.scale * 72 / 25.4);
  return R.hatch;
}

// Hatch drawn as lines. CAD programs print a hatch pattern as one stroke per line, already cut at the
// hatch's boundary, all drawn one after another. A family of them: at least HL_MIN lines of the same
// style and angle drawn in a row, at a regular spacing (HL_MIN_MM to HL_MAX_MM on paper, most of them
// one spacing from the next) and in step (two
// hatches drawn one after the other may be out of step with each other: each is a family of its own),
// whose ends meet the boundary at a slant. That last test leaves out stair treads, railing bars, louvres
// and the like: their ends meet the stringer or the rail square, all at the same place along the lines.
// A family of under 2 × HL_MIN lines must be spaced at most HL_TIGHT_MM (the steps of a stand are spaced wider).
// Returns marks (pid -> Set of subpaths) like annotFind, and the number of families.
const HL_MIN = 10, HL_MIN_MM = 0.4, HL_MAX_MM = 6, HL_TIGHT_MM = 2.2;
function lineHatch(paths, pxPerMm, dbg = null) {
  const marks = new Map(), open = [], runs = [];
  let n = 0;
  for (const P of paths) {
    if (!P.s || P.f) continue;
    P.subs.forEach((sb, i) => {
      if (sb.pts.length !== 2) return;
      const [a, b] = sb.pts, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.5) return;
      let th = Math.atan2(dy, dx); if (th < 0) th += Math.PI; if (th >= Math.PI) th -= Math.PI;
      const tol = Math.max(0.005, 0.3 / len); // a short line's angle is less sure (coordinates are rounded)
      let run = null;
      for (let k = open.length - 1; k >= 0; k--) {
        const r = open[k];
        if (P.pid - r.last > 6) { open.splice(k, 1); continue; }
        const d = Math.abs(r.th - th);
        if (r.col === P.col && r.dash === P.dash && Math.abs(r.lw - P.lw) < 0.05 && Math.min(d, Math.PI - d) < tol) { run = r; break; }
      }
      if (!run) { run = { col: P.col, dash: P.dash, lw: P.lw, th, ls: [] }; open.push(run); runs.push(run); }
      if (len >= 20 && !run.sure) { run.th = th; run.sure = true; } // the angle of a long line stands for the run
      run.ls.push({ P, i, a, b }); run.last = P.pid;
    });
  }
  // a run whose first long line was a little off splits one hatch in two (a 50 px line may be 0.3° off):
  // a run of the same style that goes on right after the previous one at nearly its angle joins it,
  // at the median angle of their long lines
  const median = (r) => {
    const long = r.ls.map((o) => { const dx = o.b[0] - o.a[0], dy = o.b[1] - o.a[1]; let t = Math.atan2(dy, dx); t -= Math.PI * Math.round((t - r.th) / Math.PI); return { t, len: Math.hypot(dx, dy) }; }).filter((o) => o.len >= 20).map((o) => o.t).sort((x, y) => x - y);
    return long.length ? long[long.length >> 1] : r.th;
  };
  for (let k = runs.length - 1; k > 0; k--) {
    const r = runs[k], q = runs[k - 1], first = r.ls[0].P.pid;
    if (r.col !== q.col || r.dash !== q.dash || Math.abs(r.lw - q.lw) >= 0.05 || first > q.last + 6 || first < q.ls[0].P.pid) continue;
    const d = Math.abs(median(r) - median(q)); if (Math.min(d, Math.PI - d) > 0.012) continue;
    q.ls.push(...r.ls); q.last = Math.max(q.last, r.last); q.joined = true; runs.splice(k, 1);
  }
  for (const r of runs) {
    if (r.ls.length < HL_MIN) continue;
    if (r.joined) r.th = median(r);
    const why = (w, x = {}) => { if (dbg) { const xs = r.ls.flatMap((o) => [o.a[0], o.b[0]]), ys = r.ls.flatMap((o) => [o.a[1], o.b[1]]); dbg.push({ why: w, n: r.ls.length, deg: +(r.th * 180 / Math.PI).toFixed(1), pids: r.ls[0].P.pid + "-" + r.ls[r.ls.length - 1].P.pid, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round), lw: r.lw, ...x }); } };
    // offset across the lines and the two ends along them, all at the run's angle
    const ux = Math.cos(r.th), uy = Math.sin(r.th);
    const ls = r.ls.map((o) => { const sa = o.a[0] * ux + o.a[1] * uy, sb = o.b[0] * ux + o.b[1] * uy; return { o, off: (-(o.a[0] + o.b[0]) * uy + (o.a[1] + o.b[1]) * ux) / 2, s0: Math.min(sa, sb), s1: Math.max(sa, sb) }; }).sort((x, y) => x.off - y.off);
    // one row per distinct offset (a line may be cut in pieces by an island): its two ends along the lines
    const rows = [];
    for (const l of ls) {
      const w = rows[rows.length - 1];
      if (w && l.off - w.off <= 0.3) { w.s0 = Math.min(w.s0, l.s0); w.s1 = Math.max(w.s1, l.s1); w.ls.push(l.o); }
      else rows.push({ off: l.off, s0: l.s0, s1: l.s1, ls: [l.o] });
    }
    if (rows.length < HL_MIN) { why("rows", { rows: rows.length }); continue; }
    // spacing: the most common gap between neighbouring rows
    const gaps = []; for (let k = 1; k < rows.length; k++) gaps.push(rows[k].off - rows[k - 1].off);
    let sp = 0, best = 0;
    const spMin = Math.max(1.5, HL_MIN_MM * pxPerMm); // closer lines are a grey fill, or details that only look regular
    for (const g of gaps) { if (g < spMin || g > HL_MAX_MM * pxPerMm) continue; const c = gaps.filter((h) => Math.abs(h - g) <= Math.max(0.3, 0.08 * g)).length; if (c > best) { best = c; sp = g; } }
    if (!sp) { why("spacing"); continue; }
    const near = gaps.filter((h) => Math.abs(h - sp) <= Math.max(0.3, 0.08 * sp)).sort((x, y) => x - y); sp = near[near.length >> 1];
    // families in step: rows grouped by their place within the spacing (two hatches may be out of step)
    const tol = Math.max(0.35, 0.12 * sp), phase = (x) => ((x % sp) + sp) % sp;
    const byPh = rows.map((w) => ({ w, ph: phase(w.off) })).sort((x, y) => x.ph - y.ph), groups = [];
    for (const e of byPh) { const g = groups[groups.length - 1]; if (g && e.ph - g.last <= tol) { g.rows.push(e.w); g.last = e.ph; } else groups.push({ rows: [e.w], first: e.ph, last: e.ph }); }
    if (groups.length > 1) { const g0 = groups[0], gz = groups[groups.length - 1]; if (g0.first + sp - gz.last <= tol) { g0.rows.push(...gz.rows); groups.pop(); } } // wraps around
    for (const g of groups) {
      const rw = g.rows.sort((x, y) => x.off - y.off);
      if (rw.length < HL_MIN) continue;
      // regular: neighbours one to four spacings apart (a missing line is a hole in the hatch)
      let regular = 0, next = 0, slant = 0;
      for (let k = 1; k < rw.length; k++) {
        const d = rw[k].off - rw[k - 1].off, m = Math.round(d / sp);
        if (m >= 1 && m <= 4 && Math.abs(d - m * sp) <= tol * Math.max(1, m / 2)) { regular++; if (m === 1) next++; }
        // ends meeting the boundary at a slant move along the lines from one line to the next
        if (Math.abs(rw[k].s0 - rw[k - 1].s0) > 0.3 * d + 0.3 || Math.abs(rw[k].s1 - rw[k - 1].s1) > 0.3 * d + 0.3) slant++;
      }
      if (regular < 0.75 * (rw.length - 1) || next < 0.6 * (rw.length - 1)) { why("irregular", { sp, rows: rw.length, reg: regular / (rw.length - 1) }); continue; }
      if (slant < 0.5 * (rw.length - 1)) { why("square", { sp, rows: rw.length, slant: slant / (rw.length - 1) }); continue; }
      // a short family spaced wide may be the steps of a stand: a hatch that small is spaced tight
      if (rw.length < 2 * HL_MIN && sp > HL_TIGHT_MM * pxPerMm) { why("few", { sp, rows: rw.length }); continue; }
      why("hatch", { sp, rows: rw.length });
      n++;
      for (const w of rw) for (const o of w.ls) { let set = marks.get(o.P.pid); if (!set) marks.set(o.P.pid, set = new Set()); set.add(o.i); }
    }
  }
  return { marks, n };
}

// A number as dimensions write it ("130", "2,40", "d=150", "Ø50", "R=25 cm")
const DIM_RE = /^\s*(?:[a-zA-ZøØ∅]{1,3}\s*[=:]?\s*)?[±+]?\s*\d{1,6}(?:[.,]\d{1,3})?\s*(?:mm|cm|m)?\s*$/;
// Level texts: "NPT ±0.00", "NIVEL 5310", "H9 ALTURA 39.40M", "+2,50"
const LEVEL_RE = /^\s*(?:(?:n\.?\s?p\.?\s?[tsn]|n\.?\s?s\.?\s?l|nivel|level|niv)\.?(?:[^a-z].{0,22})?|(?:\S{1,4}\s+)?(?:altura|cota)\b.{0,24}|[±+-]\s*\d+(?:[.,]\d+)?\s*m?)\s*$/i;

// Shapes around texts that are annotation: bubbles and tags with a text inside (axes, section and
// elevation heads, door and window tags), the marks of level texts and the line under them, the lines
// that start at those symbols (axes, section lines, level lines) with their dashes, and dimension lines
// under a number with their ticks, dots and extension lines. A circle may come as one path or as dozens
// of one-segment paths (AutoCAD). Returns marks (pid -> Set of subpaths).
// a light color (a white mask behind a view, a pale fill): no ink
const lightCol = (c) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c || ""); return !!m && 0.3 * parseInt(m[1], 16) + 0.59 * parseInt(m[2], 16) + 0.11 * parseInt(m[3], 16) > 215; };
// the letter of a section cut: A, B', A1, CC'
const CUT_RE = /^[A-Z]{1,2}\d{0,2}['’´`]{0,2}$/;
const MIN_TEXT = 3; // px: smaller texts (a key plan at 1:500) are too small to tell their symbols from the drawing
function annotFind(paths, texts, debug = false, opt = {}) {
  const subs = [];
  for (const p of paths) p.subs.forEach((s, i) => {
    const pts = s.pts; if (!pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    if (!isFinite(x0)) return;
    const a = pts[0], b = pts[pts.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const closed = s.closed || (pts.length > 2 && len < 0.75);
    let straight = !closed && len > 0.5;
    const ux = len ? (b[0] - a[0]) / len : 1, uy = len ? (b[1] - a[1]) / len : 0;
    if (straight && pts.length > 2) for (const q of pts) if (Math.abs((q[0] - a[0]) * uy - (q[1] - a[1]) * ux) > 0.6) { straight = false; break; }
    subs.push({ p, i, pts, closed, straight, curve: !!s.curve, bb: [x0, y0, x1, y1], size: Math.max(x1 - x0, y1 - y0), a, b, len, ux, uy, an: false });
  });
  if (opt.pre) for (const s of subs) if (opt.pre(s)) s.an = true; // already known (a DXF annotation layer)
  // grid of the subpaths along their segments
  const G = 32, grid = new Map();
  subs.forEach((s, n) => {
    const cells = new Set(), pts = s.pts;
    const add = (x, y) => cells.add(Math.floor(x / G) * 65536 + Math.floor(y / G));
    add(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], m = Math.ceil(Math.hypot(bx - ax, by - ay) / (G / 2));
      for (let j = 1; j <= m; j++) add(ax + (bx - ax) * j / m, ay + (by - ay) * j / m);
    }
    for (const k of cells) { let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(n); }
  });
  let stamp = 0; const seen = new Uint32Array(subs.length);
  const near = (x0, y0, x1, y1) => {
    stamp++; const out = [];
    for (let i = Math.floor(x0 / G); i <= Math.floor(x1 / G); i++) for (let j = Math.floor(y0 / G); j <= Math.floor(y1 / G); j++) {
      const l = grid.get(i * 65536 + j); if (!l) continue;
      for (const n of l) if (seen[n] !== stamp) { seen[n] = stamp; out.push(subs[n]); }
    }
    return out;
  };
  const kinds = { bubble: 0, level: 0, line: 0, dim: 0 };
  const marks = new Map(); let nMarked = 0, why = "";
  let src = null;
  const mark = (s) => { if (s.an) return; s.an = true; nMarked++; if (debug) { s.why = why; s.src = src; } let set = marks.get(s.p.pid); if (!set) marks.set(s.p.pid, set = new Set()); set.add(s.i); };
  const segDist = (px, py, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  };
  const polyDist = (px, py, pts) => { let d = Infinity; for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, py, pts[i - 1], pts[i])); return pts.length > 1 ? d : Math.hypot(px - pts[0][0], py - pts[0][1]); };
  const boxGap = (b, c) => Math.max(0, b[0] - c[2], c[0] - b[2], b[1] - c[3], c[1] - b[3]);
  // a segment crossing a box (not only its bounding box: a long diagonal passing by a corner)
  const segInBox = (a, b, box) => {
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - box[0]], [dx, box[2] - a[0]], [-dy, a[1] - box[1]], [dy, box[3] - a[1]]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  };
  const within = (b, box) => b[0] >= box[0] && b[1] >= box[1] && b[2] <= box[2] && b[3] <= box[3];
  // a shape (one closed subpath, or a loop of pieces): its points, box, corners and roundness
  const shape = (members, own = null) => {
    const pts = own || (members.length === 1 ? members[0].pts : members.flatMap((m) => m.pts));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pts) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rs = pts.map((q) => Math.hypot(q[0] - cx, q[1] - cy)), rm = rs.reduce((a, b) => a + b, 0) / rs.length;
    const v = [];
    if (members.length === 1 || own) { for (const q of pts) if (!v.some((w) => Math.abs(w[0] - q[0]) < 0.6 && Math.abs(w[1] - q[1]) < 0.6)) v.push(q); }
    else if (members.every((m) => m.straight)) for (const m of members) for (const q of [m.a, m.b]) if (!v.some((w) => Math.abs(w[0] - q[0]) < 0.6 && Math.abs(w[1] - q[1]) < 0.6)) v.push(q);
    const round = rm > 0 && (Math.max(...rs) - Math.min(...rs)) / rm < 0.12 && (members.length > 6 || pts.length > 12 || members.some((m) => m.curve));
    return { members, pts, bb: [x0, y0, x1, y1], size: Math.max(x1 - x0, y1 - y0), cx, cy, round, nv: round ? 0 : v.length, v, col: members[0].p.col };
  };
  // closed loops among open pieces: the 2-core of the graph of their segments joined end to end, so that a
  // circle can close on the middle of a polyline (a bubble drawn in one stroke with the start of its axis)
  const loops = (pieces) => {
    const segs = [];
    for (const s of pieces) for (let i = 1; i < s.pts.length; i++) { const a = s.pts[i - 1], b = s.pts[i]; if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) > 0.05) segs.push({ s, a, b }); }
    if (segs.length < 3) return [];
    const node = new Map(), par = [], find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    const key = (q) => { const x = Math.round(q[0] * 2), y = Math.round(q[1] * 2); let id = node.get(x + "," + y); if (id !== undefined) return id; id = par.length; par.push(id); node.set(x + "," + y, id);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const o = node.get((x + dx) + "," + (y + dy)); if (o !== undefined && o !== id) { const r1 = find(o), r2 = find(id); if (r1 !== r2) par[r2] = r1; } }
      return id; };
    const ends = segs.map((g) => [key(g.a), key(g.b)]);
    const E = ends.map(([a, b]) => [find(a), find(b)]), deg = new Map(), alive = segs.map(() => true);
    E.forEach(([a, b], i) => { if (a === b) { alive[i] = false; return; } deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); });
    for (let changed = true; changed;) {
      changed = false;
      E.forEach(([a, b], i) => { if (alive[i] && (deg.get(a) < 2 || deg.get(b) < 2)) { alive[i] = false; deg.set(a, deg.get(a) - 1); deg.set(b, deg.get(b) - 1); changed = true; } });
    }
    const comp = new Map(), cp = [], cf = (i) => { while (cp[i] !== i) i = cp[i] = cp[cp[i]]; return i; };
    E.forEach(([a, b], i) => { if (!alive[i]) return; for (const n of [a, b]) if (!comp.has(n)) { comp.set(n, cp.length); cp.push(cp.length); } const r1 = cf(comp.get(a)), r2 = cf(comp.get(b)); if (r1 !== r2) cp[r2] = r1; });
    const groups = new Map();
    E.forEach(([a], i) => { if (!alive[i]) return; const r = cf(comp.get(a)); let g = groups.get(r); if (!g) groups.set(r, g = []); g.push(segs[i]); });
    const out = [];
    for (const g of groups.values()) {
      if (g.length < 3) continue; // a line drawn twice
      const members = [...new Set(g.map((x) => x.s))], pts = [];
      for (const x of g) pts.push(x.a, x.b);
      const y = shape(members, pts);
      if (Math.min(y.bb[2] - y.bb[0], y.bb[3] - y.bb[1]) > 1) out.push(y);
    }
    return out;
  };
  // shapes around a box: closed subpaths and loops of open pieces, all of them inside lim
  const shapesIn = (lim, maxSize) => {
    const cand = near(lim[0], lim[1], lim[2], lim[3]).filter((s) => !s.an && s.size <= maxSize && within(s.bb, lim));
    const open = cand.filter((s) => !s.closed), curvy = open.filter((s) => s.curve || s.pts.length > 12);
    // a circle drawn in arcs: its own loop too, apart from the lines touching it
    return cand.filter((s) => s.closed || (s.p.f && !s.straight)).map((s) => shape([s])).concat(loops(open), curvy.length < open.length ? loops(curvy) : []);
  };
  // a point surrounded by a shape: its points go all the way round
  const around = (y, x, yy) => {
    if (slantTag(y)) { // a slanted tag: the point is inside it (its corners alone leave wide gaps)
      const v = ring(y.v); let inside = false;
      for (let i = 0, j = v.length - 1; i < v.length; j = i++) if ((v[i][1] > yy) !== (v[j][1] > yy) && x < (v[j][0] - v[i][0]) * (yy - v[i][1]) / (v[j][1] - v[i][1]) + v[i][0]) inside = !inside;
      return inside;
    }
    const ang = y.pts.map((q) => Math.atan2(q[1] - yy, q[0] - x)).sort((a, b) => a - b);
    let gap = ang[0] + 2 * Math.PI - ang[ang.length - 1];
    for (let i = 1; i < ang.length; i++) gap = Math.max(gap, ang[i] - ang[i - 1]);
    return gap < 1.75;
  };
  // texts with their own frame: origin at the bottom-left of the box, u along the baseline, v up
  const T = [], raw = new Set(texts.map((q) => q.s));
  for (const t of texts.concat(textLines(texts).filter((l) => !raw.has(l.s)))) {
    const s = (t.s || "").trim(); if (!s || !t.h) continue;
    const [p0, p1, p2, p3] = t.c, W = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, Hh = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) || 1;
    const xs = t.c.map((q) => q[0]), ys = t.c.map((q) => q[1]);
    T.push({ s, h: t.h, p0, u: [(p1[0] - p0[0]) / W, (p1[1] - p0[1]) / W], v: [(p3[0] - p0[0]) / Hh, (p3[1] - p0[1]) / Hh], W, Hh,
      cx: (p0[0] + p1[0] + p2[0] + p3[0]) / 4, cy: (p0[1] + p1[1] + p2[1] + p3[1]) / 4, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  const fx = (t, q) => (q[0] - t.p0[0]) * t.u[0] + (q[1] - t.p0[1]) * t.u[1], fy = (t, q) => (q[0] - t.p0[0]) * t.v[0] + (q[1] - t.p0[1]) * t.v[1];
  // a bubble holds its texts and little else: lines of its own color inside it (the dividers of a tag or a
  // section head), up to two other lines, or a pattern of one other color passing under it (floor tiles);
  // a room of a small key plan holds more
  const empty = (y) => {
    const m = 0.15 * y.size, box = [y.bb[0] + m, y.bb[1] + m, y.bb[2] - m, y.bb[3] - m], own = new Set(y.members), tol = Math.max(1, 0.05 * y.size);
    const lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    const others = near(box[0], box[1], box[2], box[3]).filter((s) => !own.has(s) && boxGap(s.bb, box) === 0 && (!s.straight || segInBox(s.a, s.b, box)) && s.size >= 0.15 * y.size && !(s.p.col === y.col && within(s.bb, lim)));
    return others.length <= 2 || others.every((s) => s.p.col === others[0].p.col && s.p.col !== y.col);
  };
  // a circle split by a line through its middle: a section or elevation head, drawn over anything
  const divided = (y) => {
    if (!y.round) return false;
    const tol = Math.max(1, 0.05 * y.size), lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    return near(lim[0], lim[1], lim[2], lim[3]).some((s) => s.straight && s.len >= 0.85 * y.size && within(s.bb, lim) && segDist(y.cx, y.cy, s.a, s.b) <= 0.1 * y.size);
  };
  const sameStyle = (a, b) => a.p.col === b.p.col && a.p.dash === b.p.dash && b.p.lw <= 1.45 * a.p.lw + 0.05 && a.p.lw <= 1.45 * b.p.lw + 0.05;
  // the end of a leader or arrow: a small dot or arrowhead (filled or closed, maybe cut in half by a wall)
  // on the line's end, of the line's color
  const termAt = (q, h, line) => {
    const r = Math.max(1.2, 0.12 * h), out = [];
    for (const d of near(q[0] - r, q[1] - r, q[0] + r, q[1] + r)) {
      if (d.an || d.straight || !(d.closed || d.p.f) || d.size > 1.6 * h || d.size < Math.min(1.5, 0.12 * h) || (line && d.p.col !== line.p.col)) continue;
      if (boxGap(d.bb, [q[0], q[1], q[0], q[1]]) <= r) out.push(d);
    }
    return out;
  };
  // a line drawn twice, and the end of a line that touches nothing else (a line of the drawing meets others)
  const dupOf = (n, l) => n.straight && ((Math.hypot(n.a[0] - l.a[0], n.a[1] - l.a[1]) <= 1 && Math.hypot(n.b[0] - l.b[0], n.b[1] - l.b[1]) <= 1) || (Math.hypot(n.a[0] - l.b[0], n.a[1] - l.b[1]) <= 1 && Math.hypot(n.b[0] - l.a[0], n.b[1] - l.a[1]) <= 1));
  const free = (q, chain) => near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1).every((n) => n.size < 1 || chain.includes(n) || chain.some((l) => dupOf(n, l)) || polyDist(q[0], q[1], n.pts) > 1);
  // corners in order around their middle (a loop of pieces lists them in any order)
  const ring = (v) => { const cx = v.reduce((a, q) => a + q[0], 0) / v.length, cy = v.reduce((a, q) => a + q[1], 0) / v.length; return v.slice().sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx)); };
  // a tag drawn as a slanted parallelogram (a level or finish tag): four corners, none square
  const slantTag = (y) => !y.round && y.nv === 4 && ring(y.v).every((q, i, v) => {
    const a = v[(i + 3) % 4], b = v[(i + 1) % 4], ax = a[0] - q[0], ay = a[1] - q[1], bx = b[0] - q[0], by = b[1] - q[1];
    const c = Math.abs(ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    return c > 0.15 && c < 0.95;
  });
  const syms = [];
  const symbol = (y, kind) => { if (y.members.some((m) => m.an)) return; y.kind = kind; for (const m of y.members) mark(m); syms.push(y); kinds[kind]++; };
  // 1. bubbles and tags: a closed shape a little bigger than a text, around the text's middle
  why = "bubble";
  for (const t of T) {
    if (t.h < MIN_TEXT) continue;
    const r = 5 * t.h;
    for (const y of shapesIn([t.cx - r, t.cy - r, t.cx + r, t.cy + r], 6.5 * t.h)) {
      const w = y.bb[2] - y.bb[0], h = y.bb[3] - y.bb[1], g = 0.2 * t.h, slant = slantTag(y);
      if (opt.levelsOnly && !slant) continue; // in a DXF the layers give the bubbles
      if (y.size < 1.0 * t.h || y.size > (y.round ? 6.5 : slant ? 7 : 4.5) * t.h || Math.min(w, h) < 0.25 * y.size) continue; // a section head is a big circle
      if (t.bb[0] < y.bb[0] - g || t.bb[1] < y.bb[1] - g || t.bb[2] > y.bb[2] + g || t.bb[3] > y.bb[3] + g) continue;
      if (Math.abs(t.cx - y.cx) > 0.3 * w || Math.abs(t.cy - y.cy) > 0.3 * h || !around(y, t.cx, t.cy) || !(empty(y) || divided(y))) continue;
      symbol(y, "bubble"); t.held = true;
    }
  }
  // 2. level texts: the triangle, diamond or circle beside them, and the line under them
  const anchors = [];
  why = "level";
  // a triangle, a circle, or a diamond (sides of about the same length, none level): a rotated plan's small
  // rectangles are not level marks
  // in the text's frame: a triangle has a side along the text and the other two alike; a diamond's corners
  // point along the text and across it
  const levelMark = (y, t) => {
    if (y.round) return true;
    if (y.nv !== 3 && y.nv !== 4) return false;
    const v = ring(y.v), n = v.length, e = v.map((q, i) => Math.hypot(v[(i + 1) % n][0] - q[0], v[(i + 1) % n][1] - q[1]));
    const along = (p, q) => Math.abs((q[0] - p[0]) * t.u[0] + (q[1] - p[1]) * t.u[1]) / (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1);
    if (n === 3) {
      const k = [0, 1, 2].find((i) => along(v[i], v[(i + 1) % 3]) > 0.98); if (k === undefined) return false;
      const e1 = e[(k + 1) % 3], e2 = e[(k + 2) % 3]; if (Math.max(e1, e2) > 1.3 * Math.min(e1, e2)) return false;
    } else {
      if (Math.max(...e) > 1.6 * Math.min(...e)) return false;
      const d1 = along(v[0], v[2]), d2 = along(v[1], v[3]);
      if (Math.max(d1, d2) < 0.97 || Math.min(d1, d2) > 0.25) return false;
    }
    // long lines ending at its corners: at most the level line (one or two pieces in line); more is a corner of the drawing
    const att = [];
    for (const q of v) for (const s of near(q[0] - 1.5, q[1] - 1.5, q[0] + 1.5, q[1] + 1.5)) {
      if (!s.straight || s.len <= 1.5 * y.size || y.members.includes(s) || att.includes(s)) continue;
      if (Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= 1.5) att.push(s);
    }
    return att.length <= 2 && att.every((s) => Math.abs(s.ux * att[0].ux + s.uy * att[0].uy) > 0.998);
  };
  for (const t of T) {
    if (t.h < MIN_TEXT || !LEVEL_RE.test(t.s)) continue;
    const h = t.h, r = 6.5 * h;

    for (const y of shapesIn([t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r], 4.2 * h)) if (y.size >= 0.3 * h && boxGap(y.bb, t.bb) <= 2.5 * h && levelMark(y, t)) { y.h = h; y.holds = t.cx > y.bb[0] && t.cx < y.bb[2] && t.cy > y.bb[1] && t.cy < y.bb[3]; y.tiny = y.size < 0.75 * h; symbol(y, "level"); }
    // the line under the text: from its mark, or with a free end; a floor or slab line under the text touches neither
    const near2 = syms.filter((y) => y.kind === "level" && boxGap(y.bb, t.bb) <= 2.5 * h); // its marks, also those another text found first
    const byMark = (s) => near2.some((y) => segDist(y.cx, y.cy, s.a, s.b) <= 0.5 * y.size || y.members.some((m) => Math.min(polyDist(s.a[0], s.a[1], m.pts), polyDist(s.b[0], s.b[1], m.pts)) <= 1.5));
    for (const s of near(t.bb[0] - h, t.bb[1] - h, t.bb[2] + h, t.bb[3] + h)) {
      if (!s.straight || s.an || Math.abs(s.ux * t.u[0] + s.uy * t.u[1]) < 0.999) continue;
      const ya = fy(t, s.a), yb = fy(t, s.b), xa = fx(t, s.a), xb = fx(t, s.b);
      if (!free(s.a, [s]) && !free(s.b, [s]) && !byMark(s)) continue;
      if (Math.max(ya, yb) <= 0.35 * h && Math.min(ya, yb) >= -1.0 * h && Math.max(xa, xb) >= -0.5 * h && Math.min(xa, xb) <= t.W + 0.5 * h) { mark(s); anchors.push(s); s.level = true; s.hh = h; s.home = [t.bb[0] - 3 * h, t.bb[1] - 3 * h, t.bb[2] + 3 * h, t.bb[3] + 3 * h]; kinds.level++; }
    }
  }
  // 3. small shapes of the symbol's color touching it (the arrow of a section head), and short lines inside a bubble
  why = "part";
  for (const y of syms.slice()) {
    const tol = Math.max(1, 0.1 * y.size), lim = [y.bb[0] - tol, y.bb[1] - tol, y.bb[2] + tol, y.bb[3] + tol];
    for (const s of near(lim[0] - y.size, lim[1] - y.size, lim[2] + y.size, lim[3] + y.size)) {
      if (s.an || boxGap(s.bb, y.bb) > tol) continue;
      if (!s.straight && (s.closed || s.p.f) && s.size <= 1.2 * y.size && s.size >= 0.2 * y.size && s.p.col === y.col && (y.round || y.kind === "level")) mark(s);
      else if (s.straight && y.round && y.kind === "level" && s.len <= 1.8 * y.size && Math.hypot((s.a[0] + s.b[0]) / 2 - y.cx, (s.a[1] + s.b[1]) / 2 - y.cy) <= 0.3 * y.size && segDist(y.cx, y.cy, s.a, s.b) <= 0.15 * y.size) mark(s); // the cross of a height mark, past its circle
      else if (s.straight && (y.kind === "bubble" || y.round) && s.len <= 1.05 * y.size && within(s.bb, lim) && (!y.round || [s.a, s.b].every((e) => Math.hypot(e[0] - y.cx, e[1] - y.cy) <= 0.5 * y.size + tol))) mark(s);
    }
    // the arrow of a section or elevation head: pieces joined to the circle, close around it
    if (y.kind !== "bubble" || !y.round) continue;
    const S0 = y.size, ext = [y.bb[0] - 0.5 * S0, y.bb[1] - 0.5 * S0, y.bb[2] + 0.5 * S0, y.bb[3] + 0.5 * S0], got = y.members.slice();
    const pool = near(ext[0], ext[1], ext[2], ext[3]).filter((s) => !s.an && !s.closed && s.len >= 0.1 * S0 && within(s.bb, ext)), add = [];
    for (let more = true; more && add.length <= 12;) {
      more = false;
      for (const s of pool) if (!got.includes(s) && [s.a, s.b].some((e) => got.some((g) => polyDist(e[0], e[1], g.pts) <= tol))) { got.push(s); add.push(s); more = true; }
    }
    if (add.length <= 12) for (const s of add) mark(s); // more is a drawing (a fixture) touching the circle
  }
  // 4. lines starting at a symbol: axes (pointing at a bubble's center), section lines, level lines (through a corner of the mark)
  why = "anchor";
  for (const y of syms) {
    if (y.kind === "level" && (y.round || y.tiny || y.holds)) continue; // a height mark (circle with a cross) has no line of its own, the dot of a leader neither
    if (y.kind === "bubble" && !y.round) continue; // a tag in a box has none either: axes and section lines start at circles
    const S0 = y.size, tol = Math.max(1.5, 0.12 * S0);
    const dist = (q) => Math.min(...y.members.map((m) => polyDist(q[0], q[1], m.pts)));
    const far = y.round ? 0.6 * S0 : tol; // an axis may start a little away from its bubble, in line with its center
    for (const s of near(y.bb[0] - far, y.bb[1] - far, y.bb[2] + far, y.bb[3] + far)) {
      if (!s.straight || s.an) continue;
      let hit = false;
      const d0 = Math.min(dist(s.a), dist(s.b)), off = Math.abs((y.cx - s.a[0]) * s.uy - (y.cy - s.a[1]) * s.ux);
      if (d0 <= tol) hit = !y.round || off <= 0.3 * S0;
      else if (y.round && d0 <= far && off <= 0.08 * S0) { const r = (q) => Math.hypot(q[0] - y.cx, q[1] - y.cy); hit = Math.max(r(s.a), r(s.b)) > 0.5 * S0 + s.len * 0.9; }
      if (!hit && y.kind === "level" && !y.round && s.len >= S0) hit = y.v.some((q) => segDist(q[0], q[1], s.a, s.b) <= tol);
      if (hit) { src = y.members[0]; mark(s); src = null; anchors.push(s); if (y.kind === "level") { s.level = true; s.hh = y.h; } s.home = [y.bb[0] - 2 * S0, y.bb[1] - 2 * S0, y.bb[2] + 2 * S0, y.bb[3] + 2 * S0]; kinds.line++; }
    }
  }
  // 4b. section cuts: a short thick bar by the section's letter (A, B', A1...) and the thin line leaving its end.
  // The bar is a narrow four-sided shape (a fill or its outline; some PDFs fill its box through a clip) or a thick stroke.
  why = "cut";
  const cutLines = [];
  const axis = (v) => { let best = null, bl = 0; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) { const dx = v[j][0] - v[i][0], dy = v[j][1] - v[i][1], l = Math.hypot(dx, dy); if (!best || Math.abs(l - sides(v)[1]) < Math.abs(bl - sides(v)[1])) { best = [dx / l, dy / l]; bl = l; } } return best; }; // direction of the long sides
  const sides = (v) => { const d = []; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) d.push(Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1])); d.sort((a, b) => a - b); return [d[0], d[2]]; }; // a rectangle's width and length
  for (const t of T) {
    if (t.h < MIN_TEXT || t.held || !CUT_RE.test(t.s)) continue; // a tag's letters (T1 in a bubble) name no cut
    const h = t.h, r = 1.2 * h, bars = [];
    const cand = near(t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r).filter((b) => !b.an && boxGap(b.bb, t.bb) <= r);
    const narrow = (v) => { const [W, L] = sides(v); return L >= 0.4 * h && L <= 4 * h && W <= 0.45 * L && W >= 0.06 * h ? L : 0; };
    for (const b of cand) {
      if (!b.straight && b.p.f && b.pts.length >= 4 && b.pts.length <= 6) { const y = shape([b]), L = y.nv === 4 && narrow(y.v); if (L) bars.push({ members: [b], v: y.v, bb: y.bb, L, ax: axis(y.v) }); }
      else if (b.straight && b.p.s && b.p.lw >= Math.max(2.5, 0.12 * h) && b.len >= 0.4 * h && b.len <= 4 * h) bars.push({ members: [b], v: [b.a, b.b], bb: b.bb, L: b.len, ax: [b.ux, b.uy] });
    }
    for (const y of loops(cand.filter((b) => b.straight && b.len <= 4 * h))) { const L = y.nv === 4 && narrow(y.v); if (L) bars.push({ members: y.members, v: y.v, bb: y.bb, L, ax: axis(y.v) }); }
    for (const bar of bars) {
      if (bar.members.some((m) => m.an)) continue;
      const L = bar.L, tol = Math.max(1.5, 0.08 * L), box = [bar.bb[0] - tol, bar.bb[1] - tol, bar.bb[2] + tol, bar.bb[3] + tol];
      const lines = near(box[0], box[1], box[2], box[3]).filter((s) => !bar.members.includes(s) && !s.an);
      const thin = lines.filter((s) => s.straight && s.len >= L && !within(s.bb, box) && bar.v.some((q) => Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= tol));
      // one line (maybe drawn twice), across the bar; nothing else touches the bar (a wall drawn thick meets other walls)
      if (!thin.length || !thin.every((s) => dupOf(s, thin[0])) || Math.abs(thin[0].ux * bar.ax[0] + thin[0].uy * bar.ax[1]) > 0.35) continue;
      const poly = bar.v.length === 4 ? ring(bar.v) : bar.v;
      const edge = (q) => poly.some((c, i) => segDist(q[0], q[1], c, poly[(i + 1) % poly.length]) <= tol);
      const touch = lines.filter((s) => s.straight && !thin.includes(s) && !within(s.bb, box) && (edge(s.a) || edge(s.b))); // lines ending at it (lines passing by are drawing under it)
      if (touch.length) continue;
      for (const m of bar.members) mark(m);
      kinds.line++;
      const col = bar.members[0].p.col;
      for (const s of lines) if (within(s.bb, box) && s.size <= L + 2 * tol && (s.p.col === col || s.p.f)) mark(s); // its outline, its fill
      for (const s of thin) { mark(s); anchors.push(s); cutLines.push(s); s.home = [bar.bb[0] - 2 * L, bar.bb[1] - 2 * L, bar.bb[2] + 2 * L, bar.bb[3] + 2 * L]; }
    }
  }
  // a stepped cut bends by a letter of its own (A1 ... A2): the piece joined to the cut line there
  const cutTexts = T.filter((t) => t.h >= MIN_TEXT && CUT_RE.test(t.s));
  for (const c of cutLines.slice()) for (const e of [c.a, c.b]) {
    if (!cutTexts.some((t) => boxGap([e[0], e[1], e[0], e[1]], t.bb) <= 1.5 * t.h)) continue;
    for (const n of near(e[0] - 1, e[1] - 1, e[0] + 1, e[1] + 1)) {
      if (n.an || !n.straight || !sameStyle(c, n) || Math.min(Math.hypot(n.a[0] - e[0], n.a[1] - e[1]), Math.hypot(n.b[0] - e[0], n.b[1] - e[1])) > 1) continue;
      mark(n); anchors.push(n); cutLines.push(n); n.home = c.home;
    }
  }
  // a level line may bend near its mark (an elbow): the lines joined end to end with it, same style, two joints at
  // most; a line across it only if it ends in a dot or arrowhead (a leader to the floor it measures)
  why = "elbow";
  const chainEnd = [];
  for (const a of anchors.filter((s) => s.level)) {
    const h = a.hh || 8;
    let front = [a];
    chainEnd.push([a, h]);
    for (let depth = 0; depth < 2 && front.length; depth++) {
      const next = [];
      for (const f of front) for (const e of [f.a, f.b]) for (const s of near(e[0] - 2, e[1] - 2, e[0] + 2, e[1] + 2)) {
        if (s.an || !s.straight || !sameStyle(f, s)) continue;
        const da = Math.hypot(s.a[0] - e[0], s.a[1] - e[1]), db = Math.hypot(s.b[0] - e[0], s.b[1] - e[1]);
        if (Math.min(da, db) > 1) continue;
        const tm = termAt(da < db ? s.b : s.a, h, s);
        if (!tm.length && (Math.abs(s.ux * f.ux + s.uy * f.uy) < 0.3 || (depth && s.len > 8 * h))) continue; // a line across it, or a long one past a bend: the drawing
        src = f; mark(s); src = null; anchors.push(s); next.push(s); s.home = f.home; s.hh = h; kinds.line++;
        chainEnd.push([s, h]);
      }
      front = next;
    }
  }
  why = "term";
  for (const [s, h] of chainEnd) for (const e of [s.a, s.b]) for (const d of termAt(e, h, s)) mark(d);
  // 4c. leaders and slope arrows: a line leaving a text (from its end, or running under it) that ends, maybe after
  // one or two bends, in a dot or an arrowhead. Its start and its bends touch nothing else: a line of the drawing
  // meets other lines at its ends.
  why = "leader";
  if (!opt.levelsOnly) for (const t of T) {
    if (t.h < MIN_TEXT) continue;
    const h = t.h, g = 0.6 * h, pt = (q) => [q[0], q[1], q[0], q[1]];
    for (const s of near(t.bb[0] - g, t.bb[1] - g, t.bb[2] + g, t.bb[3] + g)) {
      if (!s.straight || s.an || s.len > 25 * h || s.len < 0.8 * h) continue;
      const ga = boxGap(pt(s.a), t.bb), gb = boxGap(pt(s.b), t.bb), starts = []; // [far end, near end]
      if (ga <= g && gb > ga + h) starts.push([s.b, s.a]);
      else if (gb <= g && ga > gb + h) starts.push([s.a, s.b]);
      else if (Math.abs(s.ux * t.u[0] + s.uy * t.u[1]) > 0.999) { // under the text, along it
        const ya = fy(t, s.a), yb = fy(t, s.b), xa = fx(t, s.a), xb = fx(t, s.b);
        if (Math.max(ya, yb) <= 0.2 * h && Math.min(ya, yb) >= -0.8 * h && Math.min(xa, xb) <= 0.5 * t.W && Math.max(xa, xb) >= 0.5 * t.W) starts.push([s.a, s.b], [s.b, s.a]);
      }
      for (const [e0, e1] of starts) {
        if (!free(e1, [s])) continue;
        // depth-first along the bends: [lines, far end], three lines at most
        const stack = [[[s], e0]];
        let got = null;
        while (stack.length) {
          const [chain, e] = stack.pop(), last = chain[chain.length - 1], tm = termAt(e, h, last);
          if (tm.length) { got = [chain, tm]; break; }
          if (chain.length >= 3) continue;
          for (const n of near(e[0] - 1, e[1] - 1, e[0] + 1, e[1] + 1)) {
            if (n.an || !n.straight || chain.includes(n) || chain.some((l) => dupOf(n, l)) || !sameStyle(last, n) || n.len > 25 * h) continue;
            const da = Math.hypot(n.a[0] - e[0], n.a[1] - e[1]), db = Math.hypot(n.b[0] - e[0], n.b[1] - e[1]);
            if (Math.min(da, db) <= 1 && free(e, [last, n])) stack.push([chain.concat([n]), da < db ? n.b : n.a]);
          }
        }
        if (!got) continue;
        for (const x of got[0]) { mark(x); for (const n of near(x.bb[0] - 1, x.bb[1] - 1, x.bb[2] + 1, x.bb[3] + 1)) if (dupOf(n, x)) mark(n); }
        why = "term"; for (const d of got[1]) mark(d); why = "leader";
        kinds.line++;
        break;
      }
    }
  }
  // 5. the rest of those lines: same line, same style (dashes drawn one by one), up to a gap
  why = "collinear";
  const lines = new Map(), DEG = Math.PI / 180, NB = Math.round(180 / 0.25);
  const lineKey = (s) => { let th = Math.atan2(s.uy, s.ux); if (th < 0) th += Math.PI; if (th >= Math.PI - 0.125 * DEG) th -= Math.PI; return [th, -s.a[0] * Math.sin(th) + s.a[1] * Math.cos(th)]; };
  for (const s of subs) if (s.straight && s.p.s) { const [th, rho] = lineKey(s); s.th = th; s.rho = rho; const k = Math.round(th / (0.25 * DEG)) * 1e6 + Math.round(rho / 1.5); let l = lines.get(k); if (!l) lines.set(k, l = []); l.push(s); }
  let ext = 100; for (const s of subs) ext = Math.max(ext, s.bb[2], s.bb[3]);
  const maxGap = 0.025 * ext;
  for (const a of anchors) {
    if (a.th === undefined) continue;
    src = a;
    const ka = Math.round(a.th / (0.25 * DEG)), ko = Math.round(a.rho / 1.5), cand = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      let kk = ka + i, flip = 1; if (kk < 0) { kk += NB; flip = -1; } else if (kk >= NB) { kk -= NB; flip = -1; }
      for (const s of lines.get(kk * 1e6 + flip * ko + j) || []) if (s !== a && sameStyle(a, s) && Math.abs(Math.sin(s.th - a.th)) < 0.45 * DEG && Math.abs(Math.abs(s.rho) - Math.abs(a.rho)) <= Math.max(1, a.p.lw)) cand.push(s);
    }
    if (!cand.length) continue;
    const pos = (q) => q[0] * a.ux + q[1] * a.uy, span = (s) => { const p = pos(s.a), q = pos(s.b); return [Math.min(p, q), Math.max(p, q)]; };
    const all = cand.map((s) => ({ s, r: span(s) })).sort((x, y) => x.r[0] - y.r[0]);
    let [lo, hi] = span(a);
    // a level line goes on only through loose pieces (its dashes): a piece of a floor or slab meets walls at its ends
    const own = new Set(cand.concat([a])), loose = (o) => !a.level || [o.s.a, o.s.b].every((q) => near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1).every((n) => n.size < 1 || own.has(n) || n.an || polyDist(q[0], q[1], n.pts) > 1));
    // pieces that go on past the ends: a line lying on top of an axis is drawing, not the axis, unless it
    // is by the symbol (the bar of a level head drawn over the level line)
    for (const o of all) if (!o.s.an && a.home && o.r[0] >= lo && o.r[1] <= hi && within(o.s.bb, a.home)) { mark(o.s); kinds.line++; }
    for (const o of all) if (o.r[0] >= lo - 1 && o.r[1] > hi + 0.5 && o.r[0] - hi <= maxGap && loose(o)) { hi = o.r[1]; if (!o.s.an) { mark(o.s); kinds.line++; } }
    for (const o of all.slice().sort((x, y) => y.r[1] - x.r[1])) if (o.r[1] <= hi + 1 && o.r[0] < lo - 0.5 && lo - o.r[1] <= maxGap && loose(o)) { lo = o.r[0]; if (!o.s.an) { mark(o.s); kinds.line++; } }
  }
  if (opt.noDims) return debug ? { marks, n: nMarked, kinds, subs, T, dbg: [] } : { marks, n: nMarked, kinds };
  // 6. dimensions: a line parallel to a number, just under it, with ticks, dots or arrows centered on its
  // ends or extension lines crossing them. Its length must agree with the number at the scale that most
  // dimensions of the sheet agree on (a viewport's scale), which leaves out furniture and walls near a number.
  const val = (s) => { const m = s.replace(",", ".").match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
  // ends of a dimension line: ticks, dots or arrows centered on the line near its end, or extension lines
  // crossing it there and stopping just past it. The line itself may run a little past them, so the length
  // the number measures is the distance between the two terminators.
  // an extension line stands free: no other line meets its ends at an angle (a wall's ends meet other walls)
  const loose = (d, c, h) => {
    for (const q of [d.a, d.b]) for (const s of near(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1)) {
      if (s === d || s === c || !s.straight || Math.abs(s.ux * d.ux + s.uy * d.uy) > 0.9) continue;
      const k = Math.abs(s.ux * c.ux + s.uy * c.uy); if (s.len <= 2.5 * h && k > 0.55 && k < 0.85) continue; // a tick
      if (Math.min(Math.hypot(s.a[0] - q[0], s.a[1] - q[1]), Math.hypot(s.b[0] - q[0], s.b[1] - q[1])) <= 1) return false;
    }
    return true;
  };
  const terminators = (c, h) => {
    const tol = Math.max(1.5, 0.3 * h), Z = Math.min(1.2 * h, 0.3 * c.len), nx = -c.uy, ny = c.ux, found = [], pos = [];
    const along = (q) => (q[0] - c.a[0]) * c.ux + (q[1] - c.a[1]) * c.uy, perp = (q) => (q[0] - c.a[0]) * nx + (q[1] - c.a[1]) * ny;
    let strong = 0, cross = 0;
    for (const [e, sgn] of [[c.a, 1], [c.b, -1]]) {
      let st = false, ex = false; const at = [];
      const inward = (u) => (sgn > 0 ? u : c.len - u);
      for (const d of near(e[0] - 3 * h, e[1] - 3 * h, e[0] + 3 * h, e[1] + 3 * h)) {
        if (d === c) continue; // a line already taken (an axis) can still end a dimension
        if (d.straight) {
          const cos = Math.abs(d.ux * c.ux + d.uy * c.uy), mid = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
          if (d.len <= 2.5 * h && cos > 0.55 && cos < 0.85) {
            const u = along(mid), w = inward(u);
            if (Math.abs(perp(mid)) <= 0.25 * d.len + tol && w >= -tol - 0.25 * d.len && w <= Z) { found.push(d); st = true; at.push(u); }
          } else if (cos < 0.035 && d.p.col === c.p.col && d.len <= 8 * h) { // a long line there is a wall the dimension measures to
            const sa = perp(d.a), sb = perp(d.b);
            if (sa * sb >= 0) continue;
            const q = [d.a[0] + (d.b[0] - d.a[0]) * sa / (sa - sb), d.a[1] + (d.b[1] - d.a[1]) * sa / (sa - sb)], u = along(q), w = inward(u);
            const over = Math.min(Math.abs(sa), Math.abs(sb));
            if (w >= -tol && w <= Z && over >= 0.1 * h && over <= 2.5 * h && loose(d, c, h)) { found.push(d); ex = true; at.push(u); }
          }
        } else if ((d.closed || d.p.f) && d.size <= 1.5 * h) {
          const m = [(d.bb[0] + d.bb[2]) / 2, (d.bb[1] + d.bb[3]) / 2], u = along(m), w = inward(u);
          if (Math.abs(perp(m)) <= Math.max(tol, 0.6 * d.size) && w >= -tol - 0.5 * d.size && w <= Z) { found.push(d); st = true; at.push(d.curve || d.pts.length > 6 ? u : sgn > 0 ? Math.max(0, u - 0.5 * d.size) : Math.min(c.len, u + 0.5 * d.size)); } // a dot sits on the extension line, an arrow's tip touches it
        }
      }
      strong += st; cross += ex;
      if (at.length) { at.sort((x, y) => x - y); pos.push(at[at.length >> 1]); }
    }
    if (!(strong || cross === 2)) return null;
    return { f: found, len: pos.length === 2 && pos[1] - pos[0] > 0.5 * c.len ? pos[1] - pos[0] : c.len };
  };
  const dims = [], dbg = [];
  for (const t of T) {
    if (t.h < MIN_TEXT || !DIM_RE.test(t.s)) continue;
    const v = val(t.s); if (!(v > 0)) continue;
    const h = t.h, r = 2 * h, cs = [];
    for (const c of near(t.bb[0] - r, t.bb[1] - r, t.bb[2] + r, t.bb[3] + r)) {
      if (!c.straight || Math.abs(c.ux * t.u[0] + c.uy * t.u[1]) < 0.9994) continue;
      const ya = fy(t, c.a), yb = fy(t, c.b), xa = fx(t, c.a), xb = fx(t, c.b);
      if (Math.max(ya, yb) > 0.8 * t.Hh || Math.min(ya, yb) < -1.8 * h || Math.max(xa, xb) < -0.5 * h || Math.min(xa, xb) > t.W + 0.5 * h) continue;
      cs.push({ c, gap: Math.abs((ya + yb) / 2 + 0.25 * h) });
    }
    cs.sort((a, b) => a.gap - b.gap);
    let nf = 0;
    for (const { c } of cs.slice(0, 4)) { const r = terminators(c, h); if (r) { nf++; dims.push({ t, c, v, len: r.len, k: v / r.len, f: r.f }); } }
    if (debug) dbg.push({ s: t.s, h: +t.h.toFixed(1), at: t.bb.map(Math.round), u: t.u.map((q) => +q.toFixed(3)), cand: cs.length, withTerm: nf, lens: cs.slice(0, 4).map((o) => +o.c.len.toFixed(1)), ks: dims.filter((d) => d.t === t).map((d) => +d.k.toFixed(3)) });
  }
  // scales: ratios (number per pixel) shared by at least three numbers; a number with a decimal part or
  // under 20 says little about the scale on its own
  const ref = dims.filter((d) => d.v >= 20).map((d) => d.k).sort((a, b) => a - b);
  const count = (lo, hi) => { let a = 0, b = ref.length; while (a < b) { const m = (a + b) >> 1; if (ref[m] < lo) a = m + 1; else b = m; } let n = 0; for (let i = a; i < ref.length && ref[i] <= hi; i++) n++; return n; };
  const taken = new Set();
  why = "dim";
  for (const d of dims) {
    if (taken.has(d.t)) continue;
    const e = Math.max(0.55, 0.012 * d.v), lo = (d.v - e) / d.len, hi = (d.v + e) / d.len;
    if (count(lo, hi) - (d.v >= 20 ? 1 : 0) < 2) continue;
    taken.add(d.t); mark(d.c); kinds.dim++;
    why = "term"; for (const x of d.f) mark(x); why = "dim";
  }
  return debug ? { marks, n: nMarked, kinds, subs, T, dbg } : { marks, n: nMarked, kinds };
}

// ---------- sources: draw a plan with any transform (raster px -> canvas px) ----------
let liveTasks = [];
function cancelRenders() { for (const t of liveTasks) { try { t.cancel(); } catch {} } liveTasks = []; }

// fixed: draw the overview with the fill decisions already in D.keepFills (after reconcileFills)
// noHatch: leave hatch out even when the switch is on (the Plano A / Plano B views)
// all: annotation drawn whatever the switch says (the automatic alignment needs the axes)
async function renderSource(D, T, w, h, withText = false, fixed = false, noHatch = false, all = false) {
  const hatch = S.hatch && !noHatch, showAnnot = S.annot || all;
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  // annotation off: letters are neither drawn nor copied (PDF text drawn as lines, as some CAD programs export it, stays)
  const prepText = () => { if (withText) c.text = captureText(ctx); if (!showAnnot) ctx.fillText = ctx.strokeText = () => {}; };
  prepText();
  if (D.kind === "pdf") {
    const page = await D.pdf.getPage(D.page);
    const vp = page.getViewport({ scale: D.scale }), overview = T === I;
    const minPx = HATCH_MIN_MM * 72 / 25.4 * D.scale * scaleOf(T);
    const hide = showAnnot ? [] : D.ocAnnot || [];
    const oc = hide.length ? D.pdf.getOptionalContentConfig().then((cfg) => { for (const id of hide) cfg.setVisibility(id, false); return cfg; }) : undefined;
    // annotation off: also the bubbles, dimensions and level marks found by their shape;
    // hatch off: also the hatch printed as lines
    const hidden = hide.join(",");
    const am = showAnnot ? null : (await pdfAnnots(D, oc, hidden)).marks, hm = hatch ? null : (await pdfHatch(D, oc, hidden)).marks;
    let marks = am || hm;
    if (am && hm && hm.size) { marks = new Map(am); for (const [k, v] of hm) marks.set(k, new Set([...(am.get(k) || []), ...v])); }
    const draw = async (keep) => {
      const fills = watchFills(ctx, minPx, !hatch, keep, inv(T));
      if (marks && marks.size) tapFilter(ctx, marks);
      const task = page.render({ canvasContext: ctx, viewport: vp, transform: T, optionalContentConfigPromise: oc });
      liveTasks.push(task);
      try { await task.promise; } finally { liveTasks = liveTasks.filter((t) => t !== task); untap(ctx); }
      return fills;
    };
    if (overview && !hatch && !fixed) {
      // First pass without the large dark fills, to see which of them have no line along their edge.
      // Those are shapes on their own (a pillar drawn only as a black fill): the page is drawn again with
      // them, by pdf.js itself, so each keeps its place, clip and painting order.
      const fills = await draw(null);
      D.fills = loneFills(ctx, fills.skipped, D.scale * 72 / 25.4); D.keepFills = keepMap(D.fills);
      if (D.keepFills.size) {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        prepText();
        await draw(D.keepFills);
      }
      for (const f of D.fills) f.drawn = f.lone;
    } else await draw(D.keepFills || new Map());
  } else {
    if (!showAnnot) dxfAnnots(D);
    if (!hatch) dxfHatch(D);
    drawPrims(ctx, D, T, null, false, hatch, all);
  }
  return c;
}

// Copy every letter drawn into a separate canvas, so that inside the box of a text that only
// changed typeface the changes are ignored where letters are drawn and nowhere else
// (a line or symbol under the label still counts).
function captureText(ctx) {
  const P = CanvasRenderingContext2D.prototype, t = document.createElement("canvas");
  t.width = ctx.canvas.width; t.height = ctx.canvas.height;
  const x = t.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, t.width, t.height);
  const copy = (src, how, a) => {
    x.setTransform(src.getTransform()); x.font = src.font; x.textAlign = src.textAlign; x.textBaseline = src.textBaseline; x.direction = src.direction;
    x.fillStyle = x.strokeStyle = "#000"; x.lineWidth = src.lineWidth; x[how](...a);
  };
  ctx.fillText = function (...a) { copy(this, "fillText", a); return P.fillText.apply(this, a); };
  ctx.strokeText = function (...a) { copy(this, "strokeText", a); return P.strokeText.apply(this, a); };
  return t;
}

// A PDF has no hatch entity: hatch, wall poché and filled regions arrive as filled paths.
// Count the dark ones at least minPx long and, when skip is set, leave them out (except the keys in keep).
// Light fills never count as ink, and lines and text are not fills, so they are kept.
// Without keep, each left-out fill is returned with its outline in canvas pixels and the clip that
// was active, so loneFills() can check whether a line runs along its edge.
// A fill is identified by its box in the path's own units plus its box in overview pixels (Ti maps
// this canvas back to the overview), so the same shape placed twice with another transform is
// still two fills, at every zoom.
function watchFills(ctx, minPx, skip, keep, Ti = I) {
  const P = CanvasRenderingContext2D.prototype, st = { n: 0, skipped: [] }, record = skip && !keep;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, polys = [], cur = null, m = null, clip = null;
  const clips = [];
  const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  const dev = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  const dark = (c) => {
    if (typeof c !== "string") return true; // pattern or gradient fill
    let r, g, b;
    if (c[0] === "#") { r = parseInt(c.slice(1, 3), 16); g = parseInt(c.slice(3, 5), 16); b = parseInt(c.slice(5, 7), 16); }
    else { const m = c.match(/[\d.]+/g); if (!m) return true; [r, g, b] = m.map(Number); if (m.length > 3 && +m[3] < 0.3) return false; }
    return 0.299 * r + 0.587 * g + 0.114 * b < INK_THRESHOLD;
  };
  // box of the current path in canvas pixels (or, with pre, in the pixels pre maps them to)
  const box = (c, pre = null) => {
    let t = c.getTransform(); let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity;
    if (pre) { const q = mul(pre, [t.a, t.b, t.c, t.d, t.e, t.f]); t = { a: q[0], b: q[1], c: q[2], d: q[3], e: q[4], f: q[5] }; }
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
      const X = t.a * x + t.c * y + t.e, Y = t.b * x + t.d * y + t.f;
      a = Math.min(a, X); cc = Math.max(cc, X); b = Math.min(b, Y); d = Math.max(d, Y);
    }
    return [a, b, cc, d];
  };
  ctx.beginPath = function () { x0 = y0 = Infinity; x1 = y1 = -Infinity; polys = []; cur = null; return P.beginPath.call(this); };
  ctx.moveTo = function (x, y) { add(x, y); if (record) { m = this.getTransform(); cur = [dev(x, y)]; polys.push(cur); } return P.moveTo.call(this, x, y); };
  ctx.lineTo = function (x, y) { add(x, y); if (cur) cur.push(dev(x, y)); return P.lineTo.call(this, x, y); };
  ctx.bezierCurveTo = function (a, b, c, d, x, y) {
    add(a, b); add(c, d); add(x, y);
    if (cur) {
      const [px, py] = cur[cur.length - 1], c1 = dev(a, b), c2 = dev(c, d), e = dev(x, y);
      for (let t = 1; t <= 8; t++) { const u = t / 8, v = 1 - u; cur.push([v * v * v * px + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * e[0], v * v * v * py + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * e[1]]); }
    }
    return P.bezierCurveTo.call(this, a, b, c, d, x, y);
  };
  ctx.rect = function (x, y, w, h) {
    add(x, y); add(x + w, y + h);
    if (record) { m = this.getTransform(); polys.push([dev(x, y), dev(x + w, y), dev(x + w, y + h), dev(x, y + h), dev(x, y)]); cur = null; }
    return P.rect.call(this, x, y, w, h);
  };
  ctx.closePath = function () { if (cur && cur.length) cur.push(cur[0]); return P.closePath.call(this); };
  if (record) {
    // follow the clip (as a box) so that only the visible part of an edge is checked
    ctx.save = function () { clips.push(clip); return P.save.call(this); };
    ctx.restore = function () { if (clips.length) clip = clips.pop(); return P.restore.call(this); };
    ctx.clip = function (...a) {
      if (!(a[0] instanceof Path2D) && x0 !== Infinity) { const r = box(this); clip = clip ? [Math.max(clip[0], r[0]), Math.max(clip[1], r[1]), Math.min(clip[2], r[2]), Math.min(clip[3], r[3])] : r; }
      return P.clip.apply(this, a);
    };
  } else { delete ctx.save; delete ctx.restore; delete ctx.clip; }
  ctx.fill = function (...args) {
    if (!(args[0] instanceof Path2D) && x0 !== Infinity && dark(this.fillStyle)) {
      const r = box(this);
      if (Math.max(r[2] - r[0], r[3] - r[1]) >= minPx) {
        st.n++;
        if (skip) {
          const key = [x0, y0, x1, y1].map((v) => v.toFixed(2)).join(",");
          // a fill closes its open subpaths, so their closing edge is checked too
          if (record) { st.skipped.push({ key, ob: r, polys: polys.map((p) => p.length > 1 && (p[0][0] !== p[p.length - 1][0] || p[0][1] !== p[p.length - 1][1]) ? [...p, p[0]] : p), clip }); return; }
          const list = keep.get(key); if (!list) return;
          const o = box(this, Ti);
          if (!list.some((q) => Math.abs(q[0] - o[0]) < 1.5 && Math.abs(q[1] - o[1]) < 1.5 && Math.abs(q[2] - o[2]) < 1.5 && Math.abs(q[3] - o[3]) < 1.5)) return;
        }
      }
    }
    return P.fill.apply(this, args);
  };
  return st;
}
// A left-out fill with no line drawn along its edge is a shape on its own (for example a pillar
// drawn only as a black fill), not hatch or poché inside outlined walls: it is compared.
const LONE_EDGE = 0.75; // a fill with less than this share of its edge over other ink counts as lone
function inkNear(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height, d = ctx.getImageData(0, 0, W, H).data;
  return (x, y) => {
    x = Math.round(x); y = Math.round(y);
    for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++) {
      const j = (yy * W + xx) * 4; if (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2] < INK_THRESHOLD) return true;
    }
    return false;
  };
}
// share of an outline (list of closed or open point lists, canvas px) that runs over ink, counting
// only what lies on the canvas and inside clip. The clip gets 1 px of slack: PDF writers often clip
// a fill to its own outline, which then lies on the clip border give or take rounding.
// An edge that is all clipped away counts as lone.
function edgeInk(near, polys, W, H, clip = null) {
  let len = 0; for (const P of polys) for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  const step = Math.max(2, len / 400); let n = 0, hit = 0;
  for (const P of polys) for (let i = 1; i < P.length; i++) {
    const [ax, ay] = P[i - 1], [bx, by] = P[i], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let j = 0; j < m; j++) {
      const x = ax + (bx - ax) * j / m, y = ay + (by - ay) * j / m;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (clip && (x < clip[0] - 1 || y < clip[1] - 1 || x > clip[2] + 1 || y > clip[3] + 1)) continue;
      n++; if (near(x, y)) hit++;
    }
  }
  return n ? hit / n : clip ? 0 : 1;
}
// A small compact solid fill (a column or pillar in plan) is an element, not hatch: it stays when
// hatch is off even with a line along its edge. DXF columns usually come outlined and PDF ones often
// not, so without this the same pillar was kept in one format and dropped in the other.
// Each outline (canvas px) must be compact (4πA/P² ≥ PILLAR_ROUND: square 0.79, 1:2 rectangle 0.70)
// and between PILLAR_MM[0] (side of an equal-area square) and PILLAR_MM[1] (longest side) on paper.
const PILLAR_ROUND = 0.62, PILLAR_MM = [1.2, 15];
function pillar(polys, pxPerMm) {
  const P = polys.filter((p) => p.length > 3);
  if (!P.length || P.length > 64) return false;
  return P.every((p) => {
    let a = 0, per = 0;
    for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; per += Math.hypot(r[0] - q[0], r[1] - q[1]); }
    a = Math.abs(a) / 2;
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]), big = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return per > 0 && 4 * Math.PI * a / (per * per) >= PILLAR_ROUND && Math.sqrt(a) >= PILLAR_MM[0] * pxPerMm && big <= PILLAR_MM[1] * pxPerMm;
  });
}
// Left-out fills with their edge share e; lone (no line along the edge) ones and pillars are compared.
// lone0 is the plan's own decision; reconcileFills() may change lone to match the other plan.
function loneFills(ctx, list, pxPerMm) {
  if (!list.length) return [];
  const near = inkNear(ctx), W = ctx.canvas.width, H = ctx.canvas.height;
  return list.map((f) => { const e = edgeInk(near, f.polys, W, H, f.clip), pil = pillar(f.polys, pxPerMm), l = pil || e < LONE_EDGE; return { key: f.key, ob: f.ob, e, pil, lone0: l, lone: l }; });
}
// key -> overview boxes of the fills to draw
function keepMap(fills) {
  const keep = new Map();
  for (const f of fills) if (f.lone) { if (!keep.has(f.key)) keep.set(f.key, []); keep.get(f.key).push(f.ob); }
  return keep;
}
// The same wall can land just under the lone threshold in one delivery and just over it in the
// other, and would then be drawn in one plan only. Left-out fills at the same place in A and B
// (once aligned) get one decision, from their mean edge share. Plans whose decisions changed are
// drawn again. Returns false when a newer run took over.
async function reconcileFills(id) {
  const A = S.A, B = S.B;
  if (S.hatch || A.kind !== "pdf" || B.kind !== "pdf" || !A.fills || !B.fills) return true;
  for (const f of A.fills) f.lone = f.lone0;
  for (const f of B.fills) f.lone = f.lone0;
  const m = S.xf.m, cell = 16, grid = new Map(), at = (x, y) => Math.round(x / cell) + "," + Math.round(y / cell);
  for (const f of B.fills) {
    const c = [[f.ob[0], f.ob[1]], [f.ob[2], f.ob[1]], [f.ob[2], f.ob[3]], [f.ob[0], f.ob[3]]].map(([x, y]) => apply(m, x, y));
    const b = [Math.min(...c.map((p) => p[0])), Math.min(...c.map((p) => p[1])), Math.max(...c.map((p) => p[0])), Math.max(...c.map((p) => p[1]))];
    const k = at(b[0], b[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push({ f, b });
  }
  for (const a of A.fills) {
    const gx = Math.round(a.ob[0] / cell), gy = Math.round(a.ob[1] / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const { f, b } of grid.get(gx + dx + "," + (gy + dy)) || []) {
      if (f.lone0 === a.lone0 || Math.abs(b[0] - a.ob[0]) > 3 || Math.abs(b[1] - a.ob[1]) > 3 || Math.abs(b[2] - a.ob[2]) > 3 || Math.abs(b[3] - a.ob[3]) > 3) continue;
      a.lone = f.lone = a.pil || f.pil || (a.e + f.e) / 2 < LONE_EDGE;
    }
  }
  const { W, H } = S.frame;
  for (const D of [A, B]) {
    if (!D.fills.some((f) => f.lone !== f.drawn)) continue;
    D.keepFills = keepMap(D.fills);
    const c = await renderSource(D, I, D.W, D.H, true, true);
    if (id !== runId) return false;
    for (const f of D.fills) f.drawn = f.lone;
    if (D === A) { S.rasterA = c; S.maskA = inkMask(padTo(c, W, H), W, H); S.glyphA = glyphs(padTo(c.text, W, H), A); c.text = null; }
    else S.rasterB = c;
  }
  return true;
}

// Drawing units from the DXF header ($INSUNITS), as millimetres per unit; null when not set.
function mmPerUnit(dxf) {
  const u = dxf.header && dxf.header["$INSUNITS"];
  return { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 7: 1e6, 9: 0.0254, 10: 914.4, 14: 100 }[u] || null;
}

// DXF -> list of primitives in world coordinates (times f)
function dxfPrims(dxf, f = 1) {
  const out = [];
  const layers = (dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) || {};
  const hidden = (l) => { const L = layers[l]; return L && (L.visible === false || L.frozen === true); };
  const ap = (m, p) => apply(m, p.x, p.y);
  const arcPts = (cx, cy, r, a0, sweep) => { const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI * 2) * 96)); const pts = []; for (let i = 0; i <= n; i++) { const a = a0 + sweep * i / n; pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } return pts; };
  function polyWithBulge(vs, closed) {
    const pts = []; const n = vs.length;
    for (let i = 0; i < n; i++) {
      const p = vs[i], q = vs[(i + 1) % n];
      pts.push({ x: p.x, y: p.y });
      if (i === n - 1 && !closed) break;
      const b = p.bulge || 0;
      if (b && q) {
        const dx = q.x - p.x, dy = q.y - p.y, c = Math.hypot(dx, dy); if (!c) continue;
        const th = 4 * Math.atan(b), r = c / (2 * Math.sin(th / 2)), h = r * Math.cos(th / 2);
        const cx = (p.x + q.x) / 2 - dy / c * h, cy = (p.y + q.y) / 2 + dx / c * h;
        const a0 = Math.atan2(p.y - cy, p.x - cx);
        const arc = arcPts(cx, cy, Math.abs(r), a0, th); arc.shift(); arc.pop(); pts.push(...arc);
      }
    }
    if (closed && pts.length) pts.push({ ...pts[0] });
    return pts;
  }
  function bspline(e) {
    const cp = e.controlPoints || [], k = e.knotValues || [], d = e.degreeOfSplineCurve || 3;
    if (e.fitPoints && e.fitPoints.length > 1 && (!cp.length || !k.length)) return e.fitPoints;
    if (cp.length < 2 || k.length !== cp.length + d + 1) return cp;
    const lo = k[d], hi = k[cp.length], n = cp.length * 10, pts = [];
    for (let s = 0; s <= n; s++) {
      const t = Math.min(lo + (hi - lo) * s / n, hi - 1e-9);
      let i = d; while (i < cp.length - 1 && t >= k[i + 1]) i++;
      const v = []; for (let j = 0; j <= d; j++) v.push({ x: cp[i - d + j].x, y: cp[i - d + j].y });
      for (let r = 1; r <= d; r++) for (let j = d; j >= r; j--) {
        const den = k[i + 1 + j - r] - k[i - d + j]; const a = den ? (t - k[i - d + j]) / den : 0;
        v[j] = { x: (1 - a) * v[j - 1].x + a * v[j].x, y: (1 - a) * v[j - 1].y + a * v[j].y };
      }
      pts.push(v[d]);
    }
    return pts;
  }
  // \U+XXXX is how AutoCAD (and our own export) writes characters outside the drawing's code page
  const uni = (s) => (s || "").replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const cleanMtext = (s) => uni(s).replace(/\\P/g, "\n").replace(/\\[ACFHQTWfhcqtwpL][^;\\]*;?/g, "").replace(/\\[LlOoKk]/g, "").replace(/[{}]/g, "").replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±");
  const cleanText = (s) => uni(s).replace(/%%[cC]/g, "Ø").replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%[uUoO]/g, "");

  // hatch boundary edges -> points, following ezdxf: clockwise arcs store 360° minus their angles
  function edgePts(ed) {
    const m = ed.m || {};
    if (ed.type === 1) return [{ x: m[10], y: m[20] }, { x: m[11], y: m[21] }];
    if (ed.type === 2 || ed.type === 3) {
      const ccw = m[73] !== 0, s = (m[50] || 0) * Math.PI / 180, en = (m[51] ?? 360) * Math.PI / 180;
      let a0, sw;
      if (ccw) { a0 = s; sw = en - s; if (sw <= 0) sw += Math.PI * 2; } else { a0 = -s; sw = s - en; if (sw >= 0) sw -= Math.PI * 2; }
      if (ed.type === 2) return arcPts(m[10], m[20], m[40], a0, sw);
      const mx = m[11], my = m[21], r = m[40] || 1, n = 64, pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + sw * i / n, p = Math.atan2(Math.sin(a) / r, Math.cos(a)), c = Math.cos(p), sn = Math.sin(p) * r;
        pts.push({ x: m[10] + c * mx - sn * my, y: m[20] + c * my + sn * mx });
      }
      return pts;
    }
    if (ed.type === 4) return bspline({ controlPoints: ed.cp, knotValues: ed.knots, degreeOfSplineCurve: ed.deg });
    return [];
  }

  const OCS = new Set(["INSERT", "ARC", "CIRCLE", "LWPOLYLINE", "POLYLINE", "SOLID", "TEXT", "HATCH"]);
  // lay: layer that entities on layer "0" take (the block's); pan: inside an annotation block or dimension
  const annL = new Map(), annotL = (l) => { let v = annL.get(l); if (v === undefined) annL.set(l, v = annotLayer(l)); return v; };
  function walk(ents, mp, depth, lay = null, pan = false) {
    if (depth > 12) return;
    for (const e of ents || []) {
      if (e.inPaperSpace || hidden(e.layer)) continue;
      const L = !e.layer || e.layer === "0" ? lay ?? e.layer : e.layer;
      const an = pan || annotL(L) || AXIS_LT.test(e.lineType || "") || (e.type === "INSERT" && annotBlock(e.name));
      const n0 = out.length;
      // entities with extrusion (0,0,-1) are drawn mirrored (common for mirrored blocks)
      const ez = e.extrusionDirection ? e.extrusionDirection.z : e.extrusionDirectionZ;
      const m = ez < 0 && OCS.has(e.type) ? mul(mp, [-1, 0, 0, 1, 0, 0]) : mp;
      const line = (pts, closed, fill) => { if (pts && pts.length > 1) out.push({ t: "p", pts: pts.map((p) => ap(m, p)), closed, fill }); };
      switch (e.type) {
        case "LINE": line(e.vertices); break;
        case "LWPOLYLINE": case "POLYLINE": if (e.vertices) line(polyWithBulge(e.vertices, !!e.shape), false); break;
        case "CIRCLE": line(arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2)); break;
        case "ARC": { const s = e.startAngle; let sw = e.endAngle - s; if (sw <= 0) sw += Math.PI * 2; line(arcPts(e.center.x, e.center.y, e.radius, s, sw)); break; }
        case "ELLIPSE": {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y, ra = Math.hypot(mx, my), rb = ra * e.axisRatio, rot = Math.atan2(my, mx);
          const s = e.startAngle || 0, en = e.endAngle == null ? Math.PI * 2 : e.endAngle; let sw = en - s; if (sw <= 0) sw += Math.PI * 2;
          const n = 96, pts = []; for (let i = 0; i <= n; i++) { const a = s + sw * i / n, x = ra * Math.cos(a), y = rb * Math.sin(a); pts.push({ x: e.center.x + x * Math.cos(rot) - y * Math.sin(rot), y: e.center.y + x * Math.sin(rot) + y * Math.cos(rot) }); }
          line(pts); break;
        }
        case "SPLINE": line(bspline(e)); break;
        case "SOLID": case "3DFACE": if (e.points && e.points.length >= 3) { const p = e.points; const q = p.length === 4 && e.type === "SOLID" ? [p[0], p[1], p[3], p[2]] : p; line([...q, q[0]], true, true); } break;
        case "TEXT": case "ATTRIB": {
          if (!e.text) break;
          const useEnd = (e.halign || e.valign) && e.endPoint;
          const p = useEnd ? e.endPoint : e.startPoint; if (!p) break;
          out.push({ t: "x", p: ap(m, p), h: (e.textHeight || 2.5) * scaleOf(m), rot: (e.rotation || 0) * Math.PI / 180 + Math.atan2(m[1], m[0]), s: cleanText(e.text), ha: [0, 1, 2, 0, 1, 0][e.halign || 0] ?? 0, va: e.valign || 0 });
          break;
        }
        case "MTEXT": {
          if (!e.text || !e.position) break;
          const a1 = e.attachmentPoint || 1;
          const rot = e.directionVector ? Math.atan2(e.directionVector.y, e.directionVector.x) : (e.rotation || 0) * Math.PI / 180;
          out.push({ t: "x", p: ap(m, e.position), h: (e.height || 2.5) * scaleOf(m), rot: rot + Math.atan2(m[1], m[0]), s: cleanMtext(e.text), ha: (a1 - 1) % 3, va: [3, 2, 1][Math.floor((a1 - 1) / 3)], multi: true });
          break;
        }
        case "INSERT": {
          const b = dxf.blocks && dxf.blocks[e.name]; if (!b || !e.position) break;
          const sx = e.xScale ?? 1, sy = e.yScale ?? 1, r = (e.rotation || 0) * Math.PI / 180, bp = b.position || { x: 0, y: 0 };
          const T = [Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, e.position.x, e.position.y];
          walk(b.entities, mul(m, mul(T, [1, 0, 0, 1, -bp.x, -bp.y])), depth + 1, L, an);
          break;
        }
        case "DIMENSION": { const b = dxf.blocks && dxf.blocks[e.block]; if (b) walk(b.entities, m, depth + 1, L, true); break; }
        case "HATCH": {
          const loops = [];
          for (const L of e.loops) {
            const pts = L.poly ? polyWithBulge(L.poly, true) : L.edges.flatMap(edgePts);
            if (pts.length > 2 && pts.every((p) => isFinite(p.x) && isFinite(p.y))) loops.push(pts.map((p) => ap(m, p)));
          }
          if (!loops.length) break;
          const o = ap(m, { x: 0, y: 0 }), vec = (x, y) => { const q = ap(m, { x, y }); return [q[0] - o[0], q[1] - o[1]]; };
          const lines = e.solid ? [] : e.lines.map((l) => { const a = l.a * Math.PI / 180; return { b: ap(m, { x: l.bx, y: l.by }), u: vec(Math.cos(a), Math.sin(a)), o: vec(l.ox, l.oy), d: l.d }; });
          const xs = loops.flat().map((p) => p[0]), ys = loops.flat().map((p) => p[1]);
          out.push({ t: "h", loops, solid: !lines.length, lines, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
          break;
        }
      }
      if (an && e.type !== "INSERT" && e.type !== "DIMENSION") for (let i = n0; i < out.length; i++) out[i].an = true;
    }
  }
  walk(dxf.entities, [f, 0, 0, f, 0, 0], 0);
  return out;
}

function primBounds(prims) {
  const xs = [], ys = [];
  for (const p of prims) {
    if (p.t === "h") continue; // the frame does not depend on whether hatch is drawn
    if (p.t === "p") for (const q of p.pts) { xs.push(q[0]); ys.push(q[1]); }
    else { xs.push(p.p[0]); ys.push(p.p[1]); }
  }
  if (!xs.length) return null;
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  // trim far outliers (stray objects far from the sheet) without cutting a normal drawing
  let x0 = q(xs, 0.002), x1 = q(xs, 0.998), y0 = q(ys, 0.002), y1 = q(ys, 0.998);
  const w = x1 - x0 || 1, h = y1 - y0 || 1;
  x0 = Math.max(xs[0], x0 - w * 0.25); x1 = Math.min(xs[xs.length - 1], x1 + w * 0.25);
  y0 = Math.max(ys[0], y0 - h * 0.25); y1 = Math.min(ys[ys.length - 1], y1 + h * 0.25);
  return [x0, y0, x1, y1];
}

// Draw DXF primitives. World -> raster px uses D.bb/D.k/D.pad; T maps raster px -> canvas px.
// When `texts` is an array, each drawn text line's box (raster px corners) is pushed to it.
function drawPrims(ctx, D, T, texts, overview = false, hatch = S.hatch, all = false) {
  const { prims, bb, k, pad } = D, st = scaleOf(T), skip = (p) => !all && !shown(p);
  ctx.save();
  ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  ctx.strokeStyle = "#000"; ctx.fillStyle = "#000"; ctx.lineWidth = 1.25 / st; ctx.lineJoin = "round"; ctx.lineCap = "round";
  const X = (x) => (x - bb[0]) * k + pad, Y = (y) => (bb[3] - y) * k + pad;
  let vis = null;
  if (overview && !hatch) for (const p of prims) if (p.t === "h") p.keep = false; // decided again below
  for (const p of prims) {
    if (skip(p) || (!hatch && p.hl)) continue; // hatch off: also the hatch exploded into lines
    ctx.__prim = p;
    if (p.t === "h") {
      if (!hatch && !p.keep) continue;
      if (!vis) { const iv = inv(T), w = ctx.canvas.width, h = ctx.canvas.height, c = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => apply(iv, x, y)); vis = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))]; }
      drawHatch(ctx, p, X, Y, k, st, vis);
      continue;
    }
    if (p.t === "p") {
      ctx.beginPath(); ctx.moveTo(X(p.pts[0][0]), Y(p.pts[0][1]));
      for (let i = 1; i < p.pts.length; i++) ctx.lineTo(X(p.pts[i][0]), Y(p.pts[i][1]));
      if (p.fill) ctx.fill(); else ctx.stroke();
    } else {
      const px = p.h * k; if (px * st < 1.5 && !texts) continue;
      const ox = X(p.p[0]), oy = Y(p.p[1]), cs = Math.cos(-p.rot), sn = Math.sin(-p.rot);
      ctx.save(); ctx.translate(ox, oy); ctx.rotate(-p.rot);
      ctx.font = px.toFixed(2) + "px Arial, Helvetica, sans-serif";
      ctx.textAlign = ["left", "center", "right"][p.ha] || "left";
      const lines = p.s.split("\n"), lh = px * 1.4;
      let y0 = 0;
      if (p.multi) { ctx.textBaseline = "top"; const tot = lh * lines.length; y0 = p.va === 3 ? 0 : p.va === 2 ? -tot / 2 : -tot; }
      else ctx.textBaseline = ["alphabetic", "bottom", "middle", "top"][p.va] || "alphabetic";
      lines.forEach((s, i) => {
        const ly = y0 + i * lh;
        if (px * st >= 1.5) ctx.fillText(s, 0, ly);
        if (texts && s.trim()) {
          const m = ctx.measureText(s);
          const l = -m.actualBoundingBoxLeft, r = m.actualBoundingBoxRight, t = ly - m.actualBoundingBoxAscent, b = ly + m.actualBoundingBoxDescent;
          const loc = [[l, b], [r, b], [r, t], [l, t]];
          texts.push({ s, h: px, c: loc.map(([x, y]) => [ox + x * cs - y * sn, oy + x * sn + y * cs]), p });
        }
      });
      ctx.restore();
    }
  }
  // left-out solid hatch with no line along its boundary is a shape on its own, and so is a small compact
  // one (a pillar): compare it. A pattern hatch never is: soil or concrete under a section has no outline
  // either, and goes with the switch.
  if (overview && !hatch) {
    const near = inkNear(ctx), W = ctx.canvas.width, H = ctx.canvas.height, vis = [0, 0, W, H], lone = [];
    for (const p of prims) {
      if (p.t !== "h" || !p.solid || skip(p)) continue;
      const polys = p.loops.map((L) => [...L, L[0]].map((q) => [X(q[0]), Y(q[1])]));
      if (pillar(polys, DXF_PX_PER_MM) || edgeInk(near, polys, W, H) < LONE_EDGE) lone.push(p);
    }
    for (const p of lone) { p.keep = true; drawHatch(ctx, p, X, Y, k, st, vis); }
  }
  ctx.restore();
}

// A DXF primitive the "Elementos de anotación" switch lets through (texts are always annotation)
const shown = (p) => S.annot || !(p.an || p.as || p.t === "x");

// One hatch: solid ones are filled; pattern ones draw their line families inside the boundary
// (only over the visible part). Families too dense to tell apart at this zoom are filled.
function drawHatch(ctx, p, X, Y, k, st, vis) {
  const r = [Math.max(vis[0], X(p.bb[0])), Math.max(vis[1], Y(p.bb[3])), Math.min(vis[2], X(p.bb[2])), Math.min(vis[3], Y(p.bb[1]))];
  if (r[0] >= r[2] || r[1] >= r[3]) return;
  ctx.beginPath();
  for (const L of p.loops) { ctx.moveTo(X(L[0][0]), Y(L[0][1])); for (let i = 1; i < L.length; i++) ctx.lineTo(X(L[i][0]), Y(L[i][1])); ctx.closePath(); }
  if (p.solid) { ctx.fill("evenodd"); return; }
  ctx.save(); ctx.clip("evenodd");
  const corners = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], diag = Math.hypot(r[2] - r[0], r[3] - r[1]);
  for (const l of p.lines) {
    const B = [X(l.b[0]), Y(l.b[1])], U = [l.u[0] * k, -l.u[1] * k], O = [l.o[0] * k, -l.o[1] * k];
    const ul = Math.hypot(U[0], U[1]); if (!ul) continue;
    const ux = U[0] / ul, uy = U[1] / ul, sp = O[0] * -uy + O[1] * ux; // spacing between lines, raster px
    if (Math.abs(sp) * st < 1.5) { ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); break; }
    const q = corners.map(([x, y]) => ((x - B[0]) * -uy + (y - B[1]) * ux) / sp), j0 = Math.ceil(Math.min(...q)), j1 = Math.floor(Math.max(...q));
    const dash = l.d.map((d) => d * ul), per = dash.reduce((a, d) => a + Math.abs(d), 0);
    const plain = !dash.some((d) => d < 0) || per * st < 4 || (j1 - j0 + 1) * (diag / per) * dash.length > 4e5;
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      const ox = B[0] + j * O[0], oy = B[1] + j * O[1];
      const ss = corners.map(([x, y]) => (x - ox) * ux + (y - oy) * uy), s0 = Math.min(...ss), s1 = Math.max(...ss);
      if (plain) { ctx.moveTo(ox + s0 * ux, oy + s0 * uy); ctx.lineTo(ox + s1 * ux, oy + s1 * uy); continue; }
      let s = Math.floor(s0 / per) * per;
      while (s < s1) for (const d of dash) {
        if (d >= 0) { const e = s + Math.max(d, 0.01); ctx.moveTo(ox + s * ux, oy + s * uy); ctx.lineTo(ox + e * ux, oy + e * uy); }
        s += Math.abs(d);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

// PDF text items -> boxes in raster px (corners: baseline-start, baseline-end, top-end, top-start)
async function pdfTexts(D) {
  const page = await D.pdf.getPage(D.page);
  const vp = page.getViewport({ scale: D.scale });
  const tc = await page.getTextContent();
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const fs = Math.hypot(c, d) || Math.hypot(a, b); if (!fs) continue;
    const ux = a / Math.hypot(a, b), uy = b / Math.hypot(a, b), vx = c / fs, vy = d / fs;
    const w = it.width || fs * it.str.length * 0.5, desc = fs * 0.22, asc = fs * 0.9;
    const pts = [[e - vx * desc, f - vy * desc], [e + ux * w - vx * desc, f + uy * w - vy * desc], [e + ux * w + vx * asc, f + uy * w + vy * asc], [e + vx * asc, f + vy * asc]];
    out.push({ s: it.str, h: fs * D.scale, c: pts.map(([x, y]) => vp.convertToViewportPoint(x, y)) });
  }
  return out;
}

// Merge text fragments that sit on the same baseline into whole lines,
// so "DORMITORIO 1" matches even if one file splits it in two pieces.
function textLines(items) {
  const rows = items.map((t) => {
    const [p0, p1, , p3] = t.c;
    let ux = p1[0] - p0[0], uy = p1[1] - p0[1]; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
    const ang = Math.round(Math.atan2(uy, ux) * 180 / Math.PI / 2) * 2;
    const nx = -uy, ny = ux;
    return { ...t, ux, uy, ang, perp: p0[0] * nx + p0[1] * ny, a0: p0[0] * ux + p0[1] * uy, a1: p1[0] * ux + p1[1] * uy };
  });
  rows.sort((p, q) => p.ang - q.ang || p.perp - q.perp);
  const lines = [];
  let i = 0;
  while (i < rows.length) {
    const band = [rows[i]]; let j = i + 1;
    while (j < rows.length && rows[j].ang === rows[i].ang && rows[j].perp - band[band.length - 1].perp < 0.3 * Math.max(rows[j].h, rows[i].h)) band.push(rows[j++]);
    band.sort((p, q) => p.a0 - q.a0);
    let cur = null;
    for (const r of band) {
      if (cur && r.a0 - cur.a1 < 0.9 * Math.max(r.h, cur.h) && r.h / cur.h < 1.6 && cur.h / r.h < 1.6) {
        cur.s += (r.a0 - cur.a1 > 0.15 * r.h ? " " : "") + r.s; cur.c[1] = r.c[1]; cur.c[2] = r.c[2]; cur.a1 = Math.max(cur.a1, r.a1); cur.h = Math.max(cur.h, r.h);
      } else { cur = { s: r.s, h: r.h, c: r.c.map((p) => p.slice()), a1: r.a1 }; lines.push(cur); }
    }
    i = j;
  }
  return lines;
}

// Find texts that say the same thing in the same place in A and B. Returns boxes (frame px)
// where differences only come from the typeface and should be shown as matching.
function matchTexts(tA, tB, M) {
  if (!tA || !tB || !tA.length || !tB.length) return [];
  const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
  const box = (c) => { const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const sB = scaleOf(M);
  const byKey = new Map();
  for (const t of tB) {
    const c = t.c.map((p) => apply(M, p[0], p[1])), bx = box(c);
    const item = { key: norm(t.s), h: t.h * sB, bx, cx: (bx[0] + bx[2]) / 2, cy: (bx[1] + bx[3]) / 2, used: false };
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key).push(item);
  }
  const out = [];
  for (const t of tA) {
    const cand = byKey.get(norm(t.s)); if (!cand) continue;
    const bx = box(t.c), cx = (bx[0] + bx[2]) / 2, cy = (bx[1] + bx[3]) / 2;
    let best = null, bd = Infinity;
    for (const c of cand) {
      if (c.used) continue;
      // compare both the centers and the start points, since a new font changes the width
      const d = Math.min(Math.hypot(c.cx - cx, c.cy - cy), Math.hypot(c.bx[0] - bx[0], c.bx[1] - bx[1]), Math.hypot(c.bx[2] - bx[2], c.bx[3] - bx[3]));
      if (d < bd) { bd = d; best = c; }
    }
    const h = Math.max(t.h, best ? best.h : 0);
    if (best && bd < 1.2 * h + 3 && best.h / t.h < 1.8 && t.h / best.h < 1.8) {
      best.used = true;
      const p = 0.15 * h;
      out.push([Math.min(bx[0], best.bx[0]) - p, Math.min(bx[1], best.bx[1]) - p, Math.max(bx[2], best.bx[2]) + p, Math.max(bx[3], best.bx[3]) + p]);
    }
  }
  return out;
}

async function rasterize(all = false) {
  const target = RES;
  const A = S.A, B = S.B;
  S.mixed = A.kind !== B.kind;
  const prepDxf = (D, prims, bb) => {
    const pad = Math.round(target * 0.02), k = (target - 2 * pad) / Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    Object.assign(D, { prims, bb, k, pad, W: Math.ceil((bb[2] - bb[0]) * k + 2 * pad), H: Math.ceil((bb[3] - bb[1]) * k + 2 * pad) });
  };
  if (A.kind === "dxf" && B.kind === "dxf") {
    // DXF pairs usually share model coordinates. Bring both to millimetres first,
    // since one file may be drawn in mm and the other in cm or m.
    const ua = mmPerUnit(A.dxf), ub = mmPerUnit(B.dxf);
    const fa = ua && ub ? ua : 1, fb = ua && ub ? ub : 1;
    const pa = dxfPrims(A.dxf, fa), pb = dxfPrims(B.dxf, fb); A.f = fa; B.f = fb;
    const ba = primBounds(pa), bbB = primBounds(pb);
    if (!ba || !bbB) throw new Error("Uno de los DXF no tiene entidades visibles en el espacio modelo.");
    const size = (b) => Math.max(b[2] - b[0], b[3] - b[1]), r = size(ba) / size(bbB);
    const overlap = Math.min(ba[2], bbB[2]) > Math.max(ba[0], bbB[0]) && Math.min(ba[3], bbB[3]) > Math.max(ba[1], bbB[1]);
    if (r > 0.5 && r < 2 && overlap) { const bb = primBounds(pa.concat(pb)); prepDxf(A, pa, bb); prepDxf(B, pb, bb); }
    // otherwise each is drawn on its own and the automatic alignment finds scale and offset
    else { prepDxf(A, pa, ba); prepDxf(B, pb, bbB); }
  }
  else {
    for (const D of [A, B]) if (D.kind === "dxf") { D.f = 1; const p = dxfPrims(D.dxf), bb = primBounds(p); if (!bb) throw new Error("El DXF no tiene entidades visibles."); prepDxf(D, p, bb); }
  }
  // PDFs share one points-to-pixels scale so equal drawing scales stay equal
  const sizes = [];
  for (const D of [A, B]) if (D.kind === "pdf") { const p = await D.pdf.getPage(D.page), v = p.getViewport({ scale: 1 }); D.pw = v.width; D.ph = v.height; sizes.push(v.width, v.height); }
  const scale = sizes.length ? target / Math.max(...sizes) : 1;
  const out = [];
  for (const D of [A, B]) {
    if (D.kind === "pdf") {
      D.scale = scale; D.W = Math.floor(D.pw * scale); D.H = Math.floor(D.ph * scale);
      out.push(await renderSource(D, I, D.W, D.H, true, false, false, all));
      try { D.text = S.annot || all ? await pdfTexts(D) : []; } catch { D.text = []; }
    } else {
      const c = document.createElement("canvas"); c.width = D.W; c.height = D.H;
      const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, D.W, D.H);
      c.text = captureText(ctx);
      if (!S.annot && !all) dxfAnnots(D);
      if (!S.hatch) dxfHatch(D);
      const texts = []; drawPrims(ctx, D, I, texts, true, S.hatch, all); D.text = texts; out.push(c);
    }
    D.lines = textLines(D.text);
  }
  return out;
}

// ---------- masks ----------
function inkMask(canvas, W, H, thr = INK_THRESHOLD) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const a = d[j + 3] / 255;
    const lum = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * a + 255 * (1 - a);
    if (lum < thr) m[i] = 1;
  }
  return m;
}
function dilate(m, W, H, r) {
  if (r <= 0) return m.slice();
  const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W; let cnt = 0;
    for (let x = 0; x < Math.min(r, W); x++) cnt += m[row + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) cnt += m[row + x + r];
      if (x - r - 1 >= 0) cnt -= m[row + x - r - 1];
      t[row + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(r, H); y++) cnt += t[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) cnt += t[(y + r) * W + x];
      if (y - r - 1 >= 0) cnt -= t[(y - r - 1) * W + x];
      o[y * W + x] = cnt > 0 ? 1 : 0;
    }
  }
  return o;
}
const clipRect = (r, W, H) => [Math.max(0, Math.floor(r[0])), Math.max(0, Math.floor(r[1])), Math.min(W, Math.ceil(r[2])), Math.min(H, Math.ceil(r[3]))];

// Classify every inked pixel: in both (gray), only in A, only in B.
// excl and neutral are rectangles in this canvas' pixels; gA and gB mark the letters drawn in A and B
// (null when the letters could not be told apart from the rest of the drawing).
function classify(mA, mB, W, H, tol, excl, neutral, gA = null, gB = null) {
  for (const r of excl) {
    const [x0, y0, x1, y1] = clipRect(r, W, H); if (x1 <= x0) continue;
    for (let y = y0; y < y1; y++) { mA.fill(0, y * W + x0, y * W + x1); mB.fill(0, y * W + x0, y * W + x1); }
  }
  const dA = dilate(mA, W, H, tol), dB = dilate(mB, W, H, tol);
  // Inside a solid area (a filled hatch, a thick wall) the tolerance would match every pixel near the other
  // plan's lines, so a thin line over a fill came out as a thick gray band. There a pixel matches only where
  // the other plan has ink at that very pixel; the tolerance still applies near the edges.
  const edge = (m) => { const o = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) o[i] = m[i] ? 0 : 1; return dilate(o, W, H, tol + 1); };
  const eA = tol > 0 ? edge(mA) : null, eB = tol > 0 ? edge(mB) : null;
  const rem = new Uint8Array(W * H), add = new Uint8Array(W * H), com = new Uint8Array(W * H);
  let nA = 0, nB = 0, nRem = 0, nAdd = 0;
  for (let i = 0; i < W * H; i++) {
    if (mA[i]) { nA++; if (!eA || eA[i] ? dB[i] : mB[i]) com[i] = 1; else { rem[i] = 1; nRem++; } }
    if (mB[i]) { nB++; if (!eB || eB[i] ? dA[i] : mA[i]) com[i] = 1; else { add[i] = 1; nAdd++; } }
  }
  // Same text in another typeface: inside the text's box, a change is ignored only on the letters
  // (A's letters for what A lost, B's for what B gained). Lines and symbols there stay a change.
  // Without the letters of both plans nothing is ignored: a typeface change in red is better than a hidden change.
  let fontFixed = 0;
  if (neutral.length && gA && gB) {
    const GA = dilate(gA, W, H, Math.max(1, tol)), GB = dilate(gB, W, H, Math.max(1, tol));
    for (const r of neutral) {
      const [x0, y0, x1, y1] = clipRect(r, W, H); let n = 0;
      for (let y = y0; y < y1; y++) for (let i = y * W + x0, e = y * W + x1; i < e; i++) {
        if (rem[i] && GA[i]) { rem[i] = 0; nRem--; n++; }
        if (add[i] && GB[i]) { add[i] = 0; nAdd--; n++; }
        // show B's lettering only, so two overlapping typefaces don't read as a smudge
        com[i] = (mB[i] && !add[i]) || (com[i] && !GA[i]) ? 1 : 0; // B's ink still red stays red (a fill over the text)
      }
      if (n > 2) fontFixed++;
    }
  }
  return { rem, add, com, nA, nB, nRem, nAdd, fontFixed };
}

// ---------- alignment ----------
function profiles(m, W, H) {
  const col = new Float64Array(W), row = new Float64Array(H);
  for (let y = 0; y < H; y++) { const r = y * W; let s = 0; for (let x = 0; x < W; x++) { const v = m[r + x]; s += v; col[x] += v; } row[y] = s; }
  return [col, row];
}
function bestShift(a, b, maxShift) {
  // shift s so that b[i - s] lines up with a[i]
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  const A = a.map((v) => v - ma), B = b.map((v) => v - mb);
  let best = -Infinity, bestS = 0, zero = 0;
  for (let s = -maxShift; s <= maxShift; s++) {
    let acc = 0;
    const i0 = Math.max(0, s), i1 = Math.min(A.length, B.length + s);
    for (let i = i0; i < i1; i++) acc += A[i] * B[i - s];
    if (s === 0) zero = acc;
    if (acc > best) { best = acc; bestS = s; }
  }
  if (zero >= best * 0.985) return 0;
  return bestS;
}
// Positions of long straight lines (grid axes, walls, frames): strong local maxima of an ink profile.
function axisPeaks(prof, n) {
  let mx = 0; for (const v of prof) mx = Math.max(mx, v);
  const thr = mx * 0.2, out = [];
  for (let i = 0; i < prof.length; i++) {
    const v = prof[i]; if (v < thr || v === 0) continue;
    let top = true;
    for (let j = Math.max(0, i - 4); j <= Math.min(prof.length - 1, i + 4); j++) if (prof[j] > v || (prof[j] === v && j < i)) { top = false; break; }
    if (top) out.push({ p: i, v });
  }
  out.sort((a, b) => b.v - a.v);
  return out.slice(0, n).map((o) => o.p).sort((a, b) => a - b);
}
function nearestDist(sorted, x) {
  let lo = 0, hi = sorted.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m; else hi = m; }
  return Math.min(Math.abs(sorted[lo] - x), Math.abs(sorted[hi] - x));
}
const countHits = (pa, pb, s, t, tol) => { let n = 0; for (const b of pb) if (nearestDist(pa, s * b + t) < tol) n++; return n; };
// usual ratios between drawing scales (1:50 vs 1:100, 1:75 vs 1:100, ...)
const NICE = (() => { const sc = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000], r = []; for (const a of sc) for (const b of sc) r.push(b / a); return r; })();
const isNice = (s) => NICE.some((r) => Math.abs(s / r - 1) < 0.006);

// For one axis: every pair of lines in A against every pair in B proposes a scale and offset;
// keep the proposals under which most lines of B land on lines of A.
function axisProposals(pa, pb, len) {
  const tol = Math.max(2, len * 0.0015), out = [];
  for (let i = 0; i < pa.length; i++) for (let j = i + 1; j < pa.length; j++) {
    const da = pa[j] - pa[i]; if (da < len * 0.04) continue;
    for (let k = 0; k < pb.length; k++) for (let l = k + 1; l < pb.length; l++) {
      const db = pb[l] - pb[k]; if (db < len * 0.04) continue;
      const s = da / db; if (s < 0.2 || s > 5) continue;
      const t = pa[i] - s * pb[k];
      out.push({ s, t, n: countHits(pa, pb, s, t, tol) });
    }
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}
function bestOffset(pa, pb, s, len) {
  const tol = Math.max(2, len * 0.0015); let best = { t: 0, n: -1 };
  for (const a of pa) for (const b of pb) { const t = a - s * b, n = countHits(pa, pb, s, t, tol); if (n > best.n) best = { t, n }; }
  return best;
}
// How well B (placed with m) lies on A: F-score of ink near ink, on masks 1/div of the size.
function overlapScorer(rA, rB, W, H, div = 2) {
  const w = Math.max(1, Math.round(W / div)), h = Math.max(1, Math.round(H / div));
  const half = (c, m) => { const o = document.createElement("canvas"); o.width = w; o.height = h; const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.setTransform(m[0] / div, m[1] / div, m[2] / div, m[3] / div, m[4] / div, m[5] / div); x.drawImage(c, 0, 0); return inkMask(o, w, h, 245); };
  const mA = half(rA, I), dA = dilate(mA, w, h, 2); let nA = 0; for (const v of mA) nA += v;
  return (m) => {
    const mB = half(rB, m), dB = dilate(mB, w, h, 2);
    let nB = 0, hitB = 0, hitA = 0;
    for (let i = 0; i < w * h; i++) { if (mB[i]) { nB++; if (dA[i]) hitB++; } if (mA[i] && dB[i]) hitA++; }
    const P = nB ? hitB / nB : 0, R = nA ? hitA / nA : 0;
    return P + R ? 2 * P * R / (P + R) : 0;
  };
}
// The same score, quick: ink points of each plan (on masks a quarter of the size, at most ~40000 of
// them) checked against the other's dilated mask. For sorting many proposals.
function quickScorer(rA, rB) {
  const div = 4;
  const prep = (c) => {
    const w = Math.max(1, Math.ceil(c.width / div)), h = Math.max(1, Math.ceil(c.height / div));
    const o = document.createElement("canvas"); o.width = w; o.height = h;
    const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.setTransform(1 / div, 0, 0, 1 / div, 0, 0); x.drawImage(c, 0, 0);
    const m = inkMask(o, w, h, 245), pts = [];
    let n = 0; for (const v of m) n += v;
    const step = Math.max(1, Math.round(n / 40000));
    for (let i = 0, k = 0; i < m.length; i++) if (m[i] && (k++ % step === 0)) pts.push((i % w) * div + div / 2, Math.floor(i / w) * div + div / 2);
    return { w, h, d: dilate(m, w, h, 2), pts };
  };
  const A = prep(rA), B = prep(rB);
  const hits = (src, dst, m) => {
    let n = 0; const P = src.pts;
    for (let i = 0; i < P.length; i += 2) {
      const x = Math.floor((m[0] * P[i] + m[2] * P[i + 1] + m[4]) / div), y = Math.floor((m[1] * P[i] + m[3] * P[i + 1] + m[5]) / div);
      if (x >= 0 && y >= 0 && x < dst.w && y < dst.h && dst.d[y * dst.w + x]) n++;
    }
    return P.length ? n / (P.length / 2) : 0;
  };
  return (m) => {
    const det = m[0] * m[3] - m[1] * m[2], inv = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
    const P = hits(B, A, m), R = hits(A, B, inv);
    return P + R ? 2 * P * R / (P + R) : 0;
  };
}
function autoAlign(rA, rB, W, H) {
  const mA = inkMask(padTo(rA, W, H), W, H), mB = inkMask(padTo(rB, W, H), W, H);
  const [cA, rwA] = profiles(mA, W, H), [cB, rwB] = profiles(mB, W, H);
  const shift = [1, 0, 0, 1, bestShift(cA, cB, Math.round(W * 0.3)), bestShift(rwA, rwB, Math.round(H * 0.3))];
  // Same drawing at another scale: match the grid axes of A and B to find scale and offset.
  const N = 24, xa = axisPeaks(cA, N), xb = axisPeaks(cB, N), ya = axisPeaks(rwA, N), yb = axisPeaks(rwB, N);
  const cands = [];
  if (xa.length >= 2 && xb.length >= 2 && ya.length && yb.length) {
    for (const c of axisProposals(xa, xb, W).slice(0, 40)) { const o = bestOffset(ya, yb, c.s, H); cands.push({ s: c.s, tx: c.t, ty: o.t, n: c.n + o.n }); }
  }
  if (ya.length >= 2 && yb.length >= 2 && xa.length && xb.length) {
    for (const c of axisProposals(ya, yb, H).slice(0, 40)) { const o = bestOffset(xa, xb, c.s, W); cands.push({ s: c.s, tx: o.t, ty: c.t, n: c.n + o.n }); }
  }
  // The sheet's frame: the outermost lines on each side (a PDF and a DXF of one sheet are drawn at
  // unrelated sizes, and lines bunched in the middle of the sheet can outvote the frame above)
  const outer = (pa, pb, len, pa2, pb2, len2, vertical) => {
    const ends = (p) => [p.slice(0, 3), p.slice(-3)];
    const [la, ra] = ends(pa), [lb, rb] = ends(pb);
    for (const l of la) for (const r of ra) for (const l2 of lb) for (const r2 of rb) {
      if (r - l < len * 0.5 || r2 - l2 < len * 0.5) continue;
      const s = (r - l) / (r2 - l2); if (s < 0.2 || s > 5) continue;
      const t = l - s * l2, o = bestOffset(pa2, pb2, s, len2), n = countHits(pa, pb, s, t, Math.max(2, len * 0.0015)) + o.n;
      cands.push(vertical ? { s, tx: o.t, ty: t, n } : { s, tx: t, ty: o.t, n });
    }
  };
  if (xa.length >= 2 && xb.length >= 2 && ya.length && yb.length) outer(xa, xb, W, ya, yb, H, false);
  if (ya.length >= 2 && yb.length >= 2 && xa.length && xb.length) outer(ya, yb, H, xa, xb, W, true);
  for (const c of cands) c.score = c.n + (isNice(c.s) ? 1.5 : 0) + (Math.abs(c.s - 1) < 0.004 ? 0.5 : 0);
  cands.sort((a, b) => b.score - a.score);
  // a quick look at the best different proposals keeps five of them
  const distinct = [];
  for (const c of cands) {
    if (distinct.some((p) => Math.abs(p.s / c.s - 1) < 0.01 && Math.abs(p.tx - c.tx) < 4 && Math.abs(p.ty - c.ty) < 4)) continue;
    distinct.push(c); if (distinct.length >= 40) break;
  }
  const quick = quickScorer(rA, rB);
  for (const c of distinct) c.f = quick([c.s, 0, 0, c.s, c.tx, c.ty]);
  const picked = distinct.sort((a, b) => b.f - a.f).slice(0, 5);
  // Least-squares fit over all lines that matched, then snap to a usual scale ratio if close.
  const refine = (c) => {
    const pairs = (pa, pb, t, len) => { const tol = Math.max(3, len * 0.003), r = []; for (const q of pb) { const x = c.s * q + t; let a = pa[0]; for (const v of pa) if (Math.abs(v - x) < Math.abs(a - x)) a = v; if (Math.abs(a - x) < tol) r.push([q, a]); } return r; };
    const px = pairs(xa, xb, c.tx, W), py = pairs(ya, yb, c.ty, H);
    if (px.length + py.length < 3) return [c.s, 0, 0, c.s, c.tx, c.ty];
    const mean = (r, i) => r.reduce((x, p) => x + p[i], 0) / (r.length || 1);
    const mbx = mean(px, 0), max = mean(px, 1), mby = mean(py, 0), may = mean(py, 1);
    let num = 0, den = 0;
    for (const [q, a] of px) { num += (q - mbx) * (a - max); den += (q - mbx) ** 2; }
    for (const [q, a] of py) { num += (q - mby) * (a - may); den += (q - mby) ** 2; }
    let s = den ? num / den : c.s;
    const nice = NICE.find((r) => Math.abs(s / r - 1) < 0.006); if (nice) s = nice;
    return [s, 0, 0, s, px.length ? max - s * mbx : c.tx, py.length ? may - s * mby : c.ty];
  };
  const score = overlapScorer(rA, rB, W, H);
  let best = shift, bestF = score(shift);
  for (const c of picked) {
    const m = refine(c), f = score(m);
    if (f > bestF + 0.02) { best = m; bestF = f; }
  }
  if (best !== shift && Math.abs(best[0] - 1) < 0.002) best = [1, 0, 0, 1, Math.round(best[4]), Math.round(best[5])];
  return best;
}
function padTo(c, W, H) {
  if (c.width === W && c.height === H) return c;
  const o = document.createElement("canvas"); o.width = W; o.height = H;
  const x = o.getContext("2d", { willReadFrequently: true }); x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); x.drawImage(c, 0, 0); return o;
}
function warp(c, m, W, H) {
  const o = document.createElement("canvas"); o.width = W; o.height = H;
  const x = o.getContext("2d", { willReadFrequently: true });
  x.fillStyle = "#fff"; x.fillRect(0, 0, W, H);
  const pure = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
  if (pure) x.drawImage(c, Math.round(m[4]), Math.round(m[5]));
  else { x.imageSmoothingEnabled = true; x.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); x.drawImage(c, 0, 0); }
  return o;
}

// ---------- comparison (overview) ----------
function compare() {
  const { W, H } = S.frame;
  S.neutral = matchTexts(S.A.lines, S.B.lines, S.xf.m); // same text in another font is not a change
  const R = classify(S.maskA.slice(), inkMask(S.bWarp, W, H), W, H, TOL, S.excl, S.neutral, S.glyphA, S.glyphB);
  R.pct = R.nA + R.nB ? (R.nRem + R.nAdd) / (R.nA + R.nB) * 100 : 0;
  S.result = R;
  paint();
  showResult();
}

// ---------- painting ----------
// Paint a classification R into ctx.
function paintDiff(ctx, R, W, H, thick) {
  const img = ctx.createImageData(W, H), d = img.data;
  // strokes are thickened for display only, so thin CAD lines stay visible
  const remV = dilate(R.rem, W, H, thick), addV = dilate(R.add, W, H, thick), comV = dilate(R.com, W, H, thick);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    let c = null;
    // A is the reference, drawn whole in gray; B on top: what matches A is gray, what A does not have is red.
    // What only A has stays gray. Swapping A and B makes the other plan the reference.
    // a matching pixel stays gray even next to red (the red is thickened for display, the gray line must not vanish in it)
    if (R.com[i]) c = COL_MATCH; else if (addV[i]) c = COL_DIFF; else if (remV[i] || comV[i]) c = COL_MATCH;
    if (c) { d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; } else { d[j] = d[j + 1] = d[j + 2] = 255; }
    d[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function paint() {
  const { W, H } = S.frame;
  if (!S.out || S.out.width !== W || S.out.height !== H) { S.out = document.createElement("canvas"); S.out.width = W; S.out.height = H; }
  const ctx = S.out.getContext("2d");
  if (S.view === "diff") paintDiff(ctx, S.result, W, H, 1);
  else {
    const v = plainView(S.view);
    if (v) ctx.drawImage(v, 0, 0);
    else { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); makePlain().then((ok) => { if (ok) paint(); }); }
  }
  main.setCanvas(S.out);
  scheduleDetail();
}

// Plano A and Plano B views: one plan alone, without hatch, A in #545659 and B in #969ba0.
// Made from the comparison rasters when the hatch switch is off, else drawn again without hatch.
const COL_PLAIN = { A: [84, 86, 89], B: [150, 155, 160] }; // #545659 and #969ba0
function tint(c, rgb) {
  const o = document.createElement("canvas"); o.width = c.width; o.height = c.height;
  const x = o.getContext("2d"); x.drawImage(c, 0, 0);
  const img = x.getImageData(0, 0, o.width, o.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = 1 - Math.min(d[i], d[i + 1], d[i + 2]) / 255; // how much ink, keeping the line's soft edges
    d[i] = 255 - (255 - rgb[0]) * a; d[i + 1] = 255 - (255 - rgb[1]) * a; d[i + 2] = 255 - (255 - rgb[2]) * a; d[i + 3] = 255;
  }
  x.putImageData(img, 0, 0); return o;
}
const plainKey = () => [S.rasterA, S.bWarp, S.hatch];
function plainView(v) { const p = S.plain; return p && p.key.every((k, i) => k === plainKey()[i]) ? p[v] : null; }
let plainBusy = null;
function makePlain() {
  if (plainBusy) return plainBusy;
  const key = plainKey(), { W, H } = S.frame;
  plainBusy = (async () => {
    let a = S.rasterA, b = S.rasterB;
    if (S.hatch) {
      setBusy("Preparando vista…");
      [a, b] = await Promise.all([renderSource(S.A, I, S.rasterA.width, S.rasterA.height, false, true, true), renderSource(S.B, I, S.rasterB.width, S.rasterB.height, false, true, true)]);
      setBusy(null);
    }
    if (!plainKey().every((k, i) => k === key[i])) return false; // a new comparison came meanwhile
    S.plain = { key, A: tint(padTo(a, W, H), COL_PLAIN.A), B: tint(warp(b, S.xf.m, W, H), COL_PLAIN.B) };
    return true;
  })().catch((e) => { setBusy(null); if (!(e && e.name === "RenderingCancelledException")) console.error(e); return false; }).finally(() => { plainBusy = null; });
  return plainBusy;
}

function showResult() {
  const R = S.result, pct = R.pct;
  $("pct").innerHTML = (pct < 10 ? pct.toFixed(1) : Math.round(pct)).toString().replace(".", ",") + "<small>%</small>";
  $("pctLbl").textContent = "Cambios aproximados"; $("pctLbl").classList.remove("pre"); $("alignBtn").hidden = false; $("resultSec").hidden = false;
  const match = 100 - pct, noMatch = match < NO_MATCH;
  if (noMatch && !S.forceShow) { if (errKind !== "nomatch") showError(`No match: A y B coinciden solo en un ${Math.round(match)} %. Puede que no sean versiones del mismo plano, o que no se hayan podido alinear.`, "nomatch"); }
  else if (errKind === "nomatch") clearError();
  showResultStatus();
  exportButtons();
}

function alignText() {
  const m = S.xf.m;
  const isT = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
  return (S.xf.mode === "manual" ? "Manual" : "Automática") + " · B movido " +
    (isT ? `${Math.round(m[4])}, ${Math.round(m[5])} px` : `${Math.round(m[4])}, ${Math.round(m[5])} px · escala ×${scaleOf(m).toFixed(3).replace(".", ",")}` + (Math.abs(Math.atan2(m[1], m[0])) > 1e-4 ? ` · giro ${(Math.atan2(m[1], m[0]) * 180 / Math.PI).toFixed(2).replace(".", ",")}°` : ""));
}

function legend() {
  $("legend").innerHTML = LEGEND.map(([c, t]) => `<span><i class="sw" style="background:rgb(${c})"></i>${t}</span>`).join("");
}

// ---------- sharp detail when zoomed in ----------
// The overview is a fixed-size image. When zoomed in, the visible area is drawn again
// from the original PDF/DXF at screen resolution and compared again, so lines stay crisp.
let detailTimer = 0, detailId = 0, detailEl = null;
function clearDetail() { if (detailEl) { detailEl.remove(); detailEl = null; } }
function scheduleDetail() {
  clearTimeout(detailTimer);
  if (!S.result || exporting || S.running) return;
  const z = main.s * DPR();
  if (z <= 1.1) { cancelRenders(); detailId++; clearDetail(); return; }
  // keep the current detail while it still covers the view at about the right resolution
  if (detailEl && Math.abs(detailEl._z / z - 1) < 0.05 && covers(detailEl._r)) return;
  detailTimer = setTimeout(renderDetail, 220);
}
function covers(r) {
  const a = main.toFrame(main.el.getBoundingClientRect().left, main.el.getBoundingClientRect().top);
  const b = main.toFrame(main.el.getBoundingClientRect().right, main.el.getBoundingClientRect().bottom);
  const { W, H } = S.frame;
  return r[0] <= Math.max(0, a[0]) + 0.5 && r[1] <= Math.max(0, a[1]) + 0.5 && r[2] >= Math.min(W, b[0]) - 0.5 && r[3] >= Math.min(H, b[1]) - 0.5;
}
async function renderDetail() {
  const id = ++detailId;
  cancelRenders();
  const { W, H } = S.frame, er = main.el.getBoundingClientRect();
  const a = main.toFrame(er.left, er.top), b = main.toFrame(er.right, er.bottom);
  let z = Math.min(main.s * DPR(), MAX_ZOOM * 2);
  const mx = (b[0] - a[0]) * 0.15, my = (b[1] - a[1]) * 0.15;
  let r = [Math.max(0, a[0] - mx), Math.max(0, a[1] - my), Math.min(W, b[0] + mx), Math.min(H, b[1] + my)];
  if ((r[2] - r[0]) * (r[3] - r[1]) * z * z > DETAIL_BUDGET) r = [Math.max(0, a[0]), Math.max(0, a[1]), Math.min(W, b[0]), Math.min(H, b[1])];
  const area = (r[2] - r[0]) * (r[3] - r[1]); if (area <= 1) return;
  if (area * z * z > DETAIL_BUDGET) z = Math.sqrt(DETAIL_BUDGET / area);
  setStatus("Afinando detalle…");
  try {
    const out = await renderRegion(r, z, S.view, Math.max(1, Math.round(DPR())), () => id !== detailId);
    if (!out || id !== detailId) return;
    out.className = "detail";
    Object.assign(out.style, { left: r[0] + "px", top: r[1] + "px", width: (r[2] - r[0]) + "px", height: (r[3] - r[1]) + "px" });
    out._z = z; out._r = r;
    clearDetail(); detailEl = out; main.content.appendChild(out);
    showResultStatus();
  } catch (e) {
    if (e && e.name === "RenderingCancelledException") return;
    console.error(e); if (id === detailId) showResultStatus();
  }
}
// Draw frame rectangle r at z canvas px per frame px: plan A, plan B, or the comparison.
async function renderRegion(r, z, view, thick, stale = () => false) {
  const w = Math.max(1, Math.round((r[2] - r[0]) * z)), h = Math.max(1, Math.round((r[3] - r[1]) * z));
  const TA = [z, 0, 0, z, -r[0] * z, -r[1] * z];
  const m = S.xf.m, TB = [z * m[0], z * m[1], z * m[2], z * m[3], z * (m[4] - r[0]), z * (m[5] - r[1])];
  let out;
  if (view === "A") out = tint(await renderSource(S.A, TA, w, h, false, false, true), COL_PLAIN.A);
  else if (view === "B") out = tint(await renderSource(S.B, TB, w, h, false, false, true), COL_PLAIN.B);
  else {
    const [cA, cB] = await Promise.all([renderSource(S.A, TA, w, h, true), renderSource(S.B, TB, w, h, true)]);
    if (stale()) return null;
    const tol = Math.round(TOL * z);
    const sc = (q) => [(q[0] - r[0]) * z, (q[1] - r[1]) * z, (q[2] - r[0]) * z, (q[3] - r[1]) * z];
    const g = S.glyphA && S.glyphB && S.neutral.length;
    const R = classify(inkMask(cA, w, h), inkMask(cB, w, h), w, h, tol, S.excl.map(sc), S.neutral.map(sc), g && inkMask(cA.text, w, h), g && inkMask(cB.text, w, h));
    out = document.createElement("canvas"); out.width = w; out.height = h;
    paintDiff(out.getContext("2d"), R, w, h, thick);
  }
  return out;
}
function showResultStatus() {
  if (!S.A || !S.B) return;
  if (S.mixed) { setStatus("A y B tienen formatos distintos (PDF y DXF): revisa que calcen bien."); return; }
  const el = $("status"), vs = document.createElement("b"); vs.className = "vs"; vs.textContent = "VS";
  el.textContent = ""; el.append(S.A.name, vs, S.B.name); el.title = S.A.name + " vs " + S.B.name;
}

// ---------- export (PDF and DXF) ----------
let exporting = false, dlNs;
// the hatch switch, the swap and new files wait while a download is prepared, so the file describes one comparison
function setExporting(on) { exporting = on; for (const id of ["hatchBtn", "annotBtn", "redBtn", "swap", "pickA", "pickB"]) $(id).disabled = on; }
// fallback: () => [filename, blob] in a format the Claude page accepts, when it refuses this one
async function offerFile(filename, blob, fallback = null) {
  if (dlNs === undefined) dlNs = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
  if (dlNs) {
    try { await dlNs.save({ filename, data: blob }); setStatus("Descargado: " + filename); }
    catch (e) {
      const c = e && e.code;
      if (fallback && (c === "rejected_extension" || c === "extension_not_enabled")) { const [f, b] = await fallback(); return offerFile(f, b); }
      setStatus(c === "declined" ? "Descarga cancelada." : c === "rate_limited" ? "Ya hay una descarga esperando tu confirmación." : c === "too_large" ? "El archivo es demasiado grande para descargarlo aquí." : "La descarga no está disponible en esta vista.");
    }
    return;
  }
  // the page opened outside the Claude viewer (for example on your own website)
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const stem = (n) => n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "plano";
const exportName = () => `comparacion_${stem(S.A.name)}_vs_${stem(S.B.name)}`;
const fmtPct = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v))).replace(".", ",") + " %";
function exportButtons() {
  const ready = !!S.result;
  $("dlPdf").disabled = !ready;
  $("dlDxf").disabled = !(ready && S.A.kind === "dxf" && S.B.kind === "dxf");
  $("dlHint").textContent = ready && $("dlDxf").disabled ? "El DXF solo se puede generar cuando A y B son DXF." : "";
}

// Mena y Ovalle logo (img/logo-mena-y-ovalle.png, 872 x 100 px, on its own blue #16547c).
// bar/band: the DXF header bar in its own units. png: the image for the PDF. bb: the drawn part of the image (px).
// pix: the same drawing as rectangles for the DXF, [x0, y0, x1, y1, c] in px from the top left, c 1 white, 2 light blue.
const LOGO = { bar: [45.12, 1.976], band: 0.222, w: 872, h: 100, bb: [68, 14, 792, 93],
  png: "data:image/png;base64,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",
  pix: [68,14,155,15,2,201,14,239,15,2,69,15,157,16,1,157,15,160,16,2,196,15,243,16,2,69,16,160,17,1,160,16,163,17,2,193,16,246,17,2,69,17,163,18,1,163,17,165,18,2,190,17,248,18,2,528,17,529,18,2,69,18,165,19,1,165,18,167,19,2,188,18,250,19,2,284,18,285,19,1,285,18,331,19,2,348,18,381,19,2,387,18,423,19,2,449,18,464,19,2,485,18,499,19,2,516,18,518,19,2,518,18,519,19,1,519,18,527,19,2,527,18,529,19,1,547,18,578,19,2,586,18,597,19,2,619,18,630,19,2,640,18,655,19,2,671,18,682,19,2,711,18,722,19,2,758,18,792,19,2,69,19,167,20,1,167,19,168,20,2,187,19,251,20,2,284,19,331,20,1,331,19,333,20,2,346,19,348,20,2,348,19,381,20,1,388,19,424,20,1,424,19,425,20,2,449,19,463,20,1,463,19,464,20,2,486,19,487,20,2,487,19,499,20,1,499,19,500,20,2,516,19,517,20,2,517,19,529,20,1,529,18,530,20,2,545,19,547,20,2,547,19,578,20,1,578,19,580,20,2,586,19,587,20,2,587,19,597,20,1,597,19,598,20,2,618,19,619,20,2,619,19,630,20,1,640,19,654,20,1,654,19,655,20,2,756,19,758,20,2,758,19,791,20,1,69,20,168,21,1,168,20,169,21,2,186,20,252,21,2,284,20,333,21,1,333,20,334,21,2,345,20,346,21,2,346,20,380,21,1,388,20,426,21,1,426,20,427,21,2,448,20,449,21,2,449,20,464,21,1,487,20,500,21,1,515,20,516,21,2,516,20,528,21,1,528,20,529,21,2,544,20,545,21,2,545,20,580,21,1,580,20,581,21,2,587,20,598,21,1,629,20,630,21,2,639,19,640,21,2,640,20,655,21,1,754,20,756,21,2,756,20,791,21,1,69,21,169,22,1,169,21,170,22,2,185,21,253,22,2,284,21,335,22,1,344,21,345,22,2,345,21,380,22,1,388,21,427,22,1,427,21,428,22,2,448,21,464,22,1,464,20,465,22,2,487,21,488,22,2,488,21,500,22,1,500,21,501,22,2,514,21,515,22,2,515,21,527,22,1,527,21,528,22,2,543,21,544,22,2,544,21,581,22,1,581,21,582,22,2,588,21,598,22,1,598,21,599,22,2,618,20,629,22,1,639,21,655,22,1,655,20,656,22,2,69,22,170,23,1,170,22,171,23,2,184,22,254,23,2,343,22,344,23,2,344,22,380,23,1,488,22,489,23,2,489,22,501,23,1,501,22,502,23,2,514,22,527,23,1,542,22,543,23,2,543,22,582,23,1,582,22,583,23,2,587,21,588,23,2,588,22,599,23,1,617,21,618,23,2,618,22,628,23,1,638,21,639,23,2,639,22,656,23,1,753,21,754,23,2,754,21,791,23,1,69,23,171,24,1,171,23,172,24,2,183,23,254,24,2,284,22,336,24,1,336,23,337,24,2,343,23,380,24,1,380,20,381,24,2,388,22,428,24,1,428,22,429,24,2,447,22,448,24,2,448,22,465,24,1,465,22,466,24,2,489,23,490,24,2,490,23,502,24,1,502,23,503,24,2,513,23,526,24,1,526,23,527,24,2,617,23,628,24,1,628,22,629,24,2,638,23,656,24,1,656,22,657,24,2,69,24,172,25,1,172,24,173,25,2,183,24,255,25,2,447,24,466,25,1,466,24,467,25,2,490,24,503,25,1,512,24,513,25,2,513,24,525,25,1,525,24,526,25,2,542,23,583,25,1,588,23,589,25,2,589,23,599,25,1,599,23,600,25,2,616,24,617,25,2,617,24,627,25,1,637,24,638,25,2,638,24,657,25,1,752,23,753,25,2,753,23,791,25,1,284,24,337,26,1,343,24,381,26,1,388,24,429,26,1,446,24,447,26,2,447,25,467,26,1,490,25,491,26,2,491,25,503,26,1,503,25,504,26,2,511,25,512,26,2,512,25,524,26,1,524,25,525,26,2,542,25,554,26,1,554,25,558,26,2,558,25,583,26,1,589,25,600,26,1,627,24,628,26,2,637,25,657,26,1,657,24,658,26,2,752,25,791,26,1,791,19,792,26,2,182,25,255,27,2,284,26,294,27,1,325,26,326,27,2,326,26,337,27,1,342,23,343,27,2,343,26,353,27,1,353,26,354,27,2,361,26,363,27,2,370,26,373,27,2,418,26,419,27,2,419,26,429,27,1,446,26,467,27,1,491,26,492,27,2,492,26,504,27,1,504,26,505,27,2,523,26,524,27,2,542,26,552,27,1,552,26,553,27,2,572,26,573,27,2,573,26,583,27,1,616,25,627,27,1,636,26,637,27,2,637,26,647,27,1,647,26,648,27,2,762,26,764,27,2,69,25,173,28,1,173,26,174,28,2,182,27,256,28,2,327,27,337,28,1,342,27,352,28,1,352,27,353,28,2,445,26,446,28,2,446,27,455,28,1,455,27,458,28,2,458,27,467,28,1,467,26,468,28,2,492,27,493,28,2,493,27,505,28,1,505,27,506,28,2,510,27,511,28,2,511,26,523,28,1,541,23,542,28,2,542,27,551,28,1,551,27,552,28,2,573,27,574,28,2,589,26,590,28,2,590,26,600,28,1,600,26,601,28,2,615,26,616,28,2,616,27,626,28,1,626,27,627,28,2,648,26,658,28,1,658,27,659,28,2,752,26,762,28,1,398,26,399,29,2,444,28,445,29,2,445,28,455,29,1,455,28,456,29,2,457,28,458,29,2,458,28,468,29,1,468,28,469,29,2,493,28,494,29,2,494,28,506,29,1,509,28,510,29,2,510,28,522,29,1,522,28,523,29,2,574,27,583,29,1,583,25,584,29,2,615,28,626,29,1,635,28,636,29,2,636,27,646,29,1,646,27,647,29,2,648,28,649,29,2,649,28,659,29,1,659,28,660,29,2,495,29,506,30,1,506,28,507,30,2,508,29,509,30,2,509,29,521,30,1,521,29,522,30,2,590,28,591,30,2,591,28,601,30,1,601,28,602,30,2,614,28,615,30,2,615,29,625,30,1,649,29,660,30,1,68,15,69,31,2,69,28,174,31,1,342,28,351,31,1,351,28,352,31,2,443,30,444,31,2,444,29,454,31,1,454,29,455,31,2,458,29,459,31,2,459,29,469,31,1,469,30,470,31,2,494,29,495,31,2,495,30,507,31,1,507,30,509,31,2,509,30,520,31,1,591,30,602,31,1,614,30,625,31,1,625,29,626,31,2,634,30,635,31,2,635,29,645,31,1,645,29,646,31,2,752,28,761,31,1,761,28,762,31,2,68,31,139,32,2,139,31,174,32,1,181,28,256,32,2,341,28,342,32,2,342,31,352,32,1,352,31,356,32,2,356,31,360,32,1,360,31,364,32,2,364,31,369,32,1,369,31,374,32,2,374,31,378,32,1,378,31,381,32,2,443,31,454,32,1,495,31,496,32,2,496,31,520,32,1,520,30,521,32,2,574,29,584,32,1,591,31,592,32,2,592,31,602,32,1,602,30,603,32,2,649,30,650,32,2,650,30,660,32,1,660,30,661,32,2,752,31,763,32,1,763,31,765,32,2,765,31,766,32,1,766,31,770,32,2,770,31,775,32,1,775,31,779,32,2,779,31,783,32,1,783,31,788,32,2,788,31,791,32,1,140,32,141,33,2,141,32,174,33,1,181,32,217,33,2,222,32,256,33,2,342,32,381,33,1,419,27,420,33,2,442,32,443,33,2,443,32,453,33,1,453,32,454,33,2,459,31,460,33,2,460,31,470,33,1,470,32,471,33,2,496,32,497,33,2,497,32,519,33,1,519,32,520,33,2,592,32,603,33,1,613,31,614,33,2,614,31,624,33,1,624,31,625,33,2,633,31,634,33,2,634,31,644,33,1,644,31,645,33,2,142,33,143,34,2,143,33,174,34,1,181,33,214,34,2,224,33,256,34,2,442,33,453,34,1,460,33,471,34,1,497,33,498,34,2,498,33,518,34,1,518,33,519,34,2,592,33,593,34,2,593,33,603,34,1,603,32,604,34,2,612,33,613,34,2,613,33,623,34,1,650,32,651,34,2,651,32,661,34,1,661,32,662,34,2,143,34,144,35,2,225,34,256,35,2,441,34,442,35,2,442,34,452,35,1,452,34,453,35,2,460,34,461,35,2,461,34,471,35,1,471,34,472,35,2,498,34,517,35,1,541,28,550,35,1,593,34,604,35,1,612,34,623,35,1,623,33,624,35,2,632,34,633,35,2,633,33,643,35,1,643,33,644,35,2,144,34,174,36,1,181,34,212,36,2,226,35,256,36,2,441,35,452,36,1,498,35,499,36,2,499,35,517,36,1,517,34,518,36,2,541,35,542,36,2,542,35,550,36,1,594,35,604,36,1,604,35,605,36,2,651,34,652,36,2,652,34,662,36,1,662,34,663,36,2,342,33,343,37,2,343,33,381,37,1,398,33,399,37,2,440,36,441,37,2,441,36,451,37,1,451,36,452,37,2,456,36,459,37,2,461,35,462,37,2,462,35,472,37,1,472,36,473,37,2,499,36,500,37,2,500,36,516,37,1,516,36,517,37,2,593,35,594,37,2,594,36,605,37,1,611,35,612,37,2,612,35,622,37,1,622,35,623,37,2,631,35,632,37,2,632,35,642,37,1,642,35,643,37,2,652,36,653,37,2,653,36,663,37,1,342,37,381,38,1,440,37,452,38,1,452,37,455,38,2,455,37,460,38,1,460,37,461,38,2,461,37,473,38,1,500,37,501,38,2,501,37,515,38,1,515,37,516,38,2,574,32,583,38,1,583,32,584,38,2,631,37,643,38,1,643,37,652,38,2,652,37,663,38,1,663,36,664,38,2,752,32,791,38,1,342,38,352,39,1,352,38,356,39,2,356,38,361,39,1,361,38,364,39,2,364,38,369,39,1,369,38,372,39,2,372,38,378,39,1,378,38,379,39,2,379,38,380,39,1,380,38,381,39,2,439,38,440,39,2,440,38,473,39,1,473,38,474,39,2,501,38,514,39,1,514,38,515,39,2,594,37,595,39,2,595,37,605,39,1,605,38,606,39,2,610,37,611,39,2,611,37,621,39,1,752,38,767,39,1,767,38,770,39,2,770,38,775,39,1,775,38,777,39,2,777,38,784,39,1,784,38,787,39,2,787,38,791,39,1,791,31,792,39,2,69,39,98,40,2,107,39,136,40,2,356,39,360,40,2,365,39,369,40,2,373,39,377,40,2,501,39,502,40,2,502,39,514,40,1,595,39,606,40,1,610,39,621,40,1,621,37,622,40,2,630,38,631,40,2,631,38,664,40,1,664,38,665,40,2,761,39,766,40,2,771,39,774,40,2,779,39,783,40,2,788,39,791,40,2,106,40,107,41,2,107,40,136,41,1,341,38,342,41,2,438,40,439,41,2,439,39,474,41,1,474,40,475,41,2,513,40,514,41,2,574,38,584,41,1,595,40,596,41,2,596,40,606,41,1,606,40,607,41,2,609,39,610,41,2,610,40,620,41,1,629,40,630,41,2,630,40,665,41,1,106,41,136,42,1,342,39,351,42,1,351,39,352,42,2,419,37,420,42,2,541,36,550,42,1,550,28,551,42,2,596,41,607,42,1,609,41,620,42,1,620,40,621,42,2,629,41,665,42,1,665,40,666,42,2,672,19,681,42,1,681,19,682,42,2,752,39,761,42,1,761,40,762,42,2,343,42,352,43,1,352,42,353,43,2,438,41,475,43,1,475,41,476,43,2,541,42,551,43,1,551,42,552,43,2,573,42,574,43,2,574,41,583,43,1,607,42,609,43,2,609,42,619,43,1,628,42,629,43,2,629,42,666,43,1,672,42,682,43,1,682,42,683,43,2,712,19,721,43,1,721,19,722,43,2,343,43,353,44,1,353,43,354,44,2,437,42,438,44,2,438,43,476,44,1,542,43,552,44,1,552,43,553,44,2,572,43,573,44,2,573,43,583,44,1,596,42,597,44,2,597,42,607,44,1,607,43,608,44,2,608,43,619,44,1,619,42,620,44,2,628,43,666,44,1,666,42,667,44,2,672,43,683,44,1,683,43,684,44,2,711,19,712,44,2,712,43,722,44,1,722,43,724,44,2,752,42,762,44,1,762,43,763,44,2,343,44,357,45,1,357,44,360,45,2,360,44,365,45,1,365,44,368,45,2,368,44,375,45,1,375,44,377,45,2,377,44,380,45,1,380,44,381,45,2,437,44,448,45,1,448,44,451,45,2,455,44,460,45,2,464,44,466,45,2,466,44,476,45,1,476,43,477,45,2,542,44,563,45,1,563,44,567,45,2,567,44,583,45,1,627,44,628,45,2,628,44,639,45,1,639,44,641,45,2,643,44,650,45,2,653,44,656,45,2,656,44,667,45,1,672,44,685,45,1,685,44,688,45,2,688,44,702,45,1,702,44,705,45,2,705,44,709,45,1,712,44,748,45,1,752,44,772,45,1,772,44,774,45,2,774,44,779,45,1,779,44,783,45,2,783,44,788,45,1,788,44,792,45,2,398,41,399,46,2,436,44,437,46,2,437,45,447,46,1,447,45,448,46,2,465,45,466,46,2,466,45,477,46,1,583,41,584,46,2,597,44,598,46,2,618,44,619,46,2,638,45,639,46,2,656,45,657,46,2,657,45,667,46,1,667,44,668,46,2,671,19,672,46,2,672,45,708,46,1,708,45,709,46,2,342,42,343,47,2,343,45,381,47,1,435,46,436,47,2,436,46,446,47,1,467,46,477,47,1,477,45,478,47,2,541,43,542,47,2,542,45,583,47,1,598,44,618,47,1,626,46,627,47,2,627,45,638,47,1,657,46,668,47,1,668,46,669,47,2,672,46,673,47,2,673,46,708,47,1,712,45,713,47,2,713,45,748,47,1,748,44,749,47,2,752,45,753,47,2,753,45,791,47,1,343,47,344,48,2,344,47,381,48,1,466,46,467,48,2,467,47,478,48,1,542,47,543,48,2,543,47,582,48,1,582,47,583,48,2,598,47,599,48,2,637,47,638,48,2,657,47,658,48,2,673,47,674,48,2,674,47,707,48,1,707,47,708,48,2,747,47,748,48,2,344,48,345,49,2,345,48,381,49,1,435,47,446,49,1,446,46,447,49,2,468,48,478,49,1,478,47,479,49,2,543,48,544,49,2,544,48,581,49,1,581,48,582,49,2,599,47,617,49,1,617,47,618,49,2,625,48,626,49,2,626,47,637,49,1,658,47,669,49,1,669,48,670,49,2,674,48,675,49,2,675,48,706,49,1,713,47,714,49,2,714,47,747,49,1,753,47,754,49,2,754,47,791,49,1,345,49,346,50,2,346,49,381,50,1,419,46,420,50,2,434,48,435,50,2,435,49,445,50,1,445,49,446,50,2,467,48,468,50,2,468,49,479,50,1,479,49,480,50,2,513,45,514,50,2,544,49,545,50,2,545,49,580,50,1,580,49,581,50,2,599,49,600,50,2,616,49,617,50,2,636,49,637,50,2,658,49,659,50,2,675,49,676,50,2,676,49,706,50,1,706,48,707,50,2,714,49,716,50,2,716,49,746,50,1,746,49,747,50,2,754,49,756,50,2,756,49,791,50,1,346,50,347,51,2,347,50,381,51,1,388,26,398,51,1,434,50,445,51,1,545,50,547,51,2,547,50,578,51,1,578,50,580,51,2,600,49,616,51,1,625,49,636,51,1,659,49,670,51,1,676,50,677,51,2,677,50,705,51,1,705,50,706,51,2,716,50,717,51,2,717,50,745,51,1,745,50,746,51,2,756,50,757,51,2,757,50,791,51,1,283,18,284,52,2,284,27,293,52,1,293,27,294,52,2,305,26,306,52,2,306,26,315,52,1,315,26,316,52,2,327,28,328,52,2,328,28,337,52,1,337,25,338,52,2,347,51,350,52,2,350,51,381,52,1,387,19,388,52,2,388,51,397,52,1,397,51,398,52,2,420,27,429,52,1,429,25,430,52,2,433,50,434,52,2,434,51,444,52,1,444,51,445,52,2,468,50,469,52,2,469,50,480,52,1,480,51,481,52,2,502,40,503,52,2,503,40,513,52,1,547,51,550,52,2,550,51,575,52,1,575,51,578,52,2,600,51,601,52,2,601,51,615,52,1,615,51,616,52,2,624,50,625,52,2,625,51,634,52,1,634,51,636,52,2,659,51,660,52,2,660,51,670,52,1,670,50,671,52,2,678,51,680,52,2,680,51,704,52,1,704,51,705,52,2,717,51,720,52,2,720,51,744,52,1,744,51,745,52,2,758,51,760,52,2,760,51,791,52,1,791,45,792,52,2,284,52,287,53,2,292,52,293,53,2,309,52,310,53,2,361,52,364,53,2,369,52,373,53,2,378,52,381,53,2,421,52,422,53,2,433,52,435,53,2,437,52,442,53,2,472,52,477,53,2,507,52,512,53,2,602,52,605,53,2,611,52,614,53,2,628,52,631,53,2,689,52,690,53,2,697,52,699,53,2,732,52,734,53,2,740,52,742,53,2,766,52,770,53,2,774,52,779,53,2,783,52,787,53,2,106,42,107,57,2,107,42,136,57,1,106,57,136,58,1,106,58,107,60,2,107,58,136,60,1,106,60,136,62,1,68,40,69,69,2,69,40,98,69,1,68,69,98,70,1,106,62,107,70,2,107,62,136,70,1,106,70,136,71,1,181,36,211,71,2,227,36,256,71,2,181,71,212,72,2,226,71,256,72,2,286,71,293,72,2,308,71,314,72,2,328,71,330,72,2,335,71,337,72,2,351,71,357,72,2,370,71,378,72,2,390,71,397,72,2,412,71,414,72,2,434,71,441,72,2,454,71,462,72,2,475,71,481,72,2,495,71,502,72,2,519,71,521,72,2,635,71,640,72,2,655,71,660,72,2,691,71,692,72,2,727,71,728,72,2,749,71,752,72,2,767,71,768,72,2,785,71,787,72,2,106,71,107,73,2,107,71,136,73,1,181,72,213,73,2,225,72,256,73,2,285,72,293,73,2,327,72,331,73,2,350,72,358,73,2,474,72,482,73,2,494,72,503,73,2,518,72,522,73,2,616,72,621,73,2,634,72,641,73,2,654,72,662,73,2,727,72,731,73,2,106,73,136,74,1,181,73,214,74,2,224,73,256,74,2,284,73,294,74,2,306,72,315,74,2,349,73,359,74,2,369,72,379,74,2,390,72,399,74,2,433,72,442,74,2,453,72,463,74,2,473,73,482,74,2,494,73,504,74,2,633,73,642,74,2,654,73,663,74,2,745,72,754,74,2,784,72,788,74,2,181,74,218,75,2,220,74,256,75,2,284,74,288,75,2,290,74,294,75,2,312,74,316,75,2,327,73,332,75,2,349,74,353,75,2,372,74,378,75,2,390,74,394,75,2,455,74,462,75,2,473,74,477,75,2,479,74,483,75,2,500,74,504,75,2,584,72,588,75,2,616,73,620,75,2,654,74,658,75,2,659,74,663,75,2,745,74,749,75,2,783,74,788,75,2,313,75,316,76,2,334,72,337,76,2,355,74,359,76,2,494,74,498,76,2,518,73,523,76,2,606,72,611,76,2,291,75,294,77,2,335,76,337,77,2,356,76,359,77,2,411,72,414,77,2,439,74,442,77,2,726,73,731,77,2,181,75,256,78,2,292,77,294,78,2,349,75,352,78,2,373,75,376,78,2,440,77,442,78,2,584,75,589,78,2,660,75,663,78,2,725,77,731,78,2,783,75,789,78,2,312,76,316,79,2,327,75,333,79,2,335,77,338,79,2,349,78,355,79,2,372,78,376,79,2,390,75,393,79,2,396,74,399,79,2,494,76,497,79,2,501,75,504,79,2,517,76,523,79,2,584,78,590,79,2,591,72,594,79,2,606,76,612,79,2,615,75,621,79,2,654,75,657,79,2,659,78,663,79,2,725,78,732,79,2,745,75,748,79,2,751,74,755,79,2,782,78,789,79,2,106,74,107,80,2,107,74,136,80,1,182,78,256,80,2,313,79,316,80,2,327,79,338,80,2,350,79,357,80,2,390,79,394,80,2,395,79,399,80,2,411,77,415,80,2,494,79,498,80,2,499,79,504,80,2,517,79,520,80,2,786,79,789,80,2,106,80,136,81,1,182,80,255,81,2,312,80,316,81,2,327,80,337,81,2,350,80,358,81,2,494,80,503,81,2,516,80,520,81,2,183,81,255,82,2,331,81,337,82,2,353,81,359,82,2,390,80,399,82,2,494,81,504,82,2,516,81,519,82,2,521,79,524,82,2,584,79,594,82,2,606,79,613,82,2,614,79,621,82,2,654,79,663,82,2,725,79,728,82,2,729,79,732,82,2,745,79,754,82,2,782,79,785,82,2,787,80,790,82,2,106,81,107,83,2,107,81,136,83,1,183,82,254,83,2,390,82,394,83,2,395,82,399,83,2,500,82,504,83,2,516,82,524,83,2,606,82,620,83,2,745,82,749,83,2,750,82,755,83,2,781,82,785,83,2,786,82,790,83,2,106,83,136,84,1,184,83,253,84,2,396,83,399,84,2,516,83,525,84,2,588,82,594,84,2,606,83,616,84,2,617,83,620,84,2,781,83,790,84,2,185,84,252,85,2,284,75,287,85,2,313,81,316,85,2,332,82,337,85,2,349,83,352,85,2,356,82,359,85,2,397,84,399,85,2,411,80,414,85,2,473,75,476,85,2,480,75,483,85,2,515,84,525,85,2,724,82,733,85,2,106,84,107,86,2,107,84,136,86,1,186,85,251,86,2,284,85,288,86,2,291,83,294,86,2,305,74,309,86,2,312,85,316,86,2,333,85,337,86,2,349,85,353,86,2,355,85,359,86,2,411,85,415,86,2,418,71,421,86,2,432,74,436,86,2,439,83,442,86,2,473,85,477,86,2,479,85,483,86,2,494,82,498,86,2,515,85,520,86,2,521,85,525,86,2,611,84,616,86,2,633,74,636,86,2,639,74,643,86,2,654,82,657,86,2,660,82,663,86,2,690,72,693,86,2,730,85,733,86,2,781,84,791,86,2,106,86,136,87,1,187,86,250,87,2,284,86,294,87,2,349,86,358,87,2,411,86,421,87,2,473,86,483,87,2,494,86,497,87,2,522,86,525,87,2,589,84,594,87,2,633,86,642,87,2,723,85,727,87,2,730,86,734,87,2,781,86,784,87,2,68,70,69,88,2,69,70,98,88,1,189,87,248,88,2,285,87,294,88,2,306,86,315,88,2,333,86,338,88,2,350,87,358,88,2,396,85,399,88,2,412,87,420,88,2,433,86,442,88,2,474,87,482,88,2,494,87,498,88,2,515,86,518,88,2,522,87,526,88,2,606,84,609,88,2,611,86,615,88,2,617,84,621,88,2,634,87,642,88,2,654,86,663,88,2,751,83,755,88,2,780,87,784,88,2,788,86,791,88,2,68,88,98,89,1,106,87,107,89,2,107,87,136,89,1,191,88,247,89,2,286,88,292,89,2,307,88,314,89,2,327,81,330,89,2,334,88,337,89,2,351,88,357,89,2,373,79,376,89,2,390,83,393,89,2,397,88,399,89,2,413,88,419,89,2,434,88,441,89,2,456,75,459,89,2,475,88,481,89,2,495,88,497,89,2,501,83,504,89,2,515,88,517,89,2,523,88,526,89,2,568,72,571,89,2,584,82,587,89,2,590,87,594,89,2,607,88,609,89,2,612,88,615,89,2,618,88,620,89,2,635,88,641,89,2,654,88,661,89,2,675,72,678,89,2,690,86,698,89,2,709,72,712,89,2,723,87,726,89,2,731,87,734,89,2,745,83,748,89,2,751,88,754,89,2,766,72,769,89,2,780,88,783,89,2,789,88,791,89,2,68,89,69,90,2,69,89,98,90,1,98,40,99,90,2,106,89,136,90,1,136,40,137,90,2,144,36,145,90,2,145,36,174,90,1,174,29,175,90,2,193,89,244,90,2,68,90,98,91,2,106,90,137,91,2,145,90,175,91,2,197,90,240,91,2,545,67,549,93,2] };
// date and time for the downloads, with plain spaces (the PDF fonts have no narrow spaces)
const stamp = () => new Date().toLocaleString("es-CL").replace(/[\u00a0\u202f]/g, " ");
const CREDIT = "Desarrollado por IDISOL";
const CREDIT_URL = "https://www.idisol.com/";
const SECRETO = "Si encontraste esto eres un genio y me debes un almuerzo. Atte. Felipe Borquez";
const PRIVACY = "Los archivos se procesan en tu navegador y no se suben a ningún servidor.";
// The PDF fonts only have the Windows Latin characters: others become a near equivalent or "?".
const WIN_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const pdfSafe = (s) => s.normalize("NFC").replace(/[^\x20-\x7e\xa0-\xff]/gu, (c) => WIN_EXTRA.includes(c) ? c : ({ "≥": ">=", "≤": "<=", "№": "No", "\u2009": " ", "\u202f": " " }[c] ?? "?"));
// shorten a line in the middle until it fits w (mm), so the start and the end of a file name stay
function fitWidth(doc, s, w) {
  if (doc.getTextWidth(s) <= w) return s;
  let lo = 1, hi = s.length;
  while (lo < hi) { const n = (lo + hi + 1) >> 1, k = Math.ceil(n / 2); if (doc.getTextWidth(s.slice(0, k) + "…" + s.slice(s.length - (n - k))) <= w) lo = n; else hi = n - 1; }
  const k = Math.ceil(lo / 2); return s.slice(0, k) + "…" + s.slice(s.length - (lo - k));
}
// hatch and fills a plan left out of the comparison (lone ones are compared, so they do not count)
const leftOut = (D) => D.kind === "pdf" ? (D.fills || []).filter((f) => !f.lone).length : (D.prims || []).filter((p) => p.t === "h" && !p.keep).length;
// what was left out of the comparison, for the downloads
function exportNotes() {
  const R = S.result, out = [], n = R.fontFixed;
  if (n) out.push(n === 1 ? "1 texto igual con otra fuente ignorado" : `${n} textos iguales con otra fuente ignorados`);
  if (!S.hatch && leftOut(S.A) + leftOut(S.B) > 0) out.push("hatch con contorno excluidos (los rellenos sin contorno sí se comparan)");
  if (!S.annot) out.push("elementos de anotación excluidos (ejes, cotas, textos, niveles y marcas de corte)");
  return out;
}

// The PDF's header repeats the page's: brand bar with logo, title, legend and privacy note.
function pdfHeader(doc, pw) {
  const bh = 16, band = [22, 84, 124], light = [207, 216, 224];
  doc.setFillColor(...band); doc.rect(0, 0, pw, bh, "F");
  doc.setFillColor(150, 155, 160); doc.rect(0, bh, pw, 1.2, "F");
  // logo: the image on its own blue (the band's), its drawn part starting 12 mm from the edge
  const bb = LOGO.bb, lh = 9.6, k = lh / LOGO.h, lx = 12 - bb[0] * k, ly = (bh - lh) / 2;
  doc.addImage(LOGO.png, "PNG", lx, ly, LOGO.w * k, lh, "logo", "FAST");
  let x = lx + bb[2] * k + 8;
  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(255, 255, 255);
  doc.text("Comparador de Planos", x, bh / 2, { baseline: "middle" });
  x += doc.getTextWidth("Comparador de Planos");
  // legend pill: centered on the page when there is room, else right after the title
  doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
  const sw = 6, gap = 2.2, tws = LEGEND.map(([, t]) => doc.getTextWidth(t));
  const lw = 10 + tws.reduce((a, t) => a + sw + gap + t, 0) + 6 * (LEGEND.length - 1), lht = 7;
  const px = Math.max(pw / 2 - lw / 2, x + 8), py = bh / 2 - lht / 2;
  doc.setFillColor(255, 255, 255); doc.roundedRect(px, py, lw, lht, lht / 2, lht / 2, "F");
  let cx = px + 5; doc.setLineWidth(1.1); doc.setLineCap("round");
  doc.setTextColor(22, 84, 124);
  LEGEND.forEach(([c, t], i) => {
    doc.setDrawColor(...c); doc.line(cx + 0.5, bh / 2, cx + sw - 0.5, bh / 2); cx += sw + gap;
    doc.text(t, cx, bh / 2, { baseline: "middle" }); cx += tws[i] + 6;
  });
  doc.setLineCap("butt");
  // privacy note on the right, in up to two lines (smaller on a narrow page, three lines at most)
  doc.setTextColor(...light);
  const room = pw - 10 - (px + lw + 8);
  if (room > 30) {
    let fs = 8.5, lines;
    for (fs of [8.5, 7.5, 7]) { doc.setFontSize(fs); lines = doc.getTextWidth(PRIVACY) <= room ? [PRIVACY] : doc.splitTextToSize(PRIVACY, room); if (lines.length <= 2) break; }
    const lh2 = fs * 0.42, y0 = bh / 2 - (lines.length - 1) * lh2 / 2;
    lines.forEach((t, i) => doc.text(t, pw - 10, y0 + i * lh2, { baseline: "middle", align: "right" }));
  }
  return bh + 1.2;
}

async function exportPdf() {
  if (!S.result || exporting || S.running) return;
  if (!window.jspdf) { setStatus("No se pudo cargar el generador de PDF. Revisa tu conexión y recarga la página."); return; }
  setExporting(true); cancelRenders(); detailId++;
  setBusy("Preparando PDF…"); await new Promise((r) => setTimeout(r, 30));
  try {
    const { W, H } = S.frame, R = S.result;
    const doc = new window.jspdf.jsPDF({ orientation: W >= H ? "landscape" : "portrait", unit: "mm", format: "a3", compress: true });
    const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), mg = 12;
    const ink = [22, 84, 124], muted = [35, 124, 173];
    let y = pdfHeader(doc, pw) + 13;
    // summary: approximate change, date, files and what was left out
    doc.setFont("helvetica", "bold"); doc.setFontSize(28); doc.setTextColor(...COL_DIFF);
    const pct = fmtPct(R.pct); doc.text(pct, mg, y);
    const x = mg + doc.getTextWidth(pct) + 4;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(...ink); doc.text("Cambios aproximados", x, y - 1);
    doc.setFontSize(9); doc.setTextColor(...muted);
    doc.text(stamp(), pw - mg, y - 1, { align: "right" });
    const aw0 = pw - 2 * mg, a = pdfSafe(`A: ${S.A.name}`), b = pdfSafe(`B: ${S.B.name}`);
    y += 6.5;
    if (doc.getTextWidth(a + "     " + b) <= aw0) doc.text(a + "     " + b, mg, y);
    else { doc.text(fitWidth(doc, a, aw0), mg, y); y += 4.6; doc.text(fitWidth(doc, b, aw0), mg, y); }
    const notes = exportNotes();
    if (notes.length) { y += 4.6; doc.text(fitWidth(doc, notes.join("  ·  "), aw0), mg, y); }
    y += 5;
    // the whole comparison, redrawn from the plans at a higher resolution than the screen, tile by tile
    const aw = pw - 2 * mg, ah = ph - y - 14, s = Math.min(aw / W, ah / H), w = W * s, h = H * s, x0 = (pw - w) / 2;
    await pdfComparison(doc, x0, y, s, W, H);
    doc.setDrawColor(...COL_MATCH); doc.setLineWidth(0.2); doc.rect(x0, y, w, h);
    doc.setFontSize(8); doc.setTextColor(207, 216, 224); doc.text(CREDIT, pw / 2, ph - 6.5, { align: "center" });
    { const cw = doc.getTextWidth(CREDIT); doc.link(pw / 2 - cw / 2, ph - 9.5, cw, 4, { url: CREDIT_URL }); }
    doc.setFont("helvetica", "normal"); doc.setFontSize(4); doc.setTextColor(255, 255, 255); doc.text(pdfSafe(SECRETO), pw - 3, ph - 2.5, { align: "right" }); // hidden signature, white on white
    await offerFile(exportName() + ".pdf", doc.output("blob"));
  } catch (e) { console.error(e); setStatus("No se pudo generar el PDF: " + (e.message || e)); }
  finally { setExporting(false); setBusy(null); scheduleDetail(); } // the export stopped any sharp detail being drawn
}

// Draw the comparison into the PDF at x0,y (mm), s mm per frame px. Each tile is compared with a margin,
// so a line near its edge still finds its match in the neighbouring tile, and the margin is cut off.
async function pdfComparison(doc, x0, y0, s, W, H) {
  const z = Math.max(1, PDF_RES / Math.max(W, H)), step = PDF_TILE / z, pad = TOL + 4;
  const nx = Math.ceil(W / step), ny = Math.ceil(H / step);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    setBusy(`Preparando PDF… ${j * nx + i + 1} / ${nx * ny}`);
    await new Promise((res) => setTimeout(res, 20)); // let the counter show and the page breathe between tiles
    const r = [i * step, j * step, Math.min(W, (i + 1) * step), Math.min(H, (j + 1) * step)];
    const rr = [Math.max(0, r[0] - pad), Math.max(0, r[1] - pad), Math.min(W, r[2] + pad), Math.min(H, r[3] + pad)];
    const big = await renderRegion(rr, z, "diff", 1);
    const tw = Math.round((r[2] - r[0]) * z), th = Math.round((r[3] - r[1]) * z);
    const t = document.createElement("canvas"); t.width = tw; t.height = th;
    t.getContext("2d").drawImage(big, Math.round((r[0] - rr[0]) * z), Math.round((r[1] - rr[1]) * z), tw, th, 0, 0, tw, th);
    doc.addImage(t, "PNG", x0 + r[0] * s, y0 + r[1] * s, (r[2] - r[0]) * s, (r[3] - r[1]) * s, undefined, "FAST");
    big.width = big.height = t.width = t.height = 0; // free the memory before the next tile
  }
}

// Header of the downloaded DXF, like the page's: brand bar with logo, title, legend and privacy note,
// then the result and the files, above the plan; the credit below it. ext: the plan's box in A's units.
// Drawn in the bar's own units scaled to the plan's width.
// Colors are AutoCAD color numbers (DXF R12 has no true colors), the nearest to the page's: 144 header blue (#16547c),
// 253 gray line under it (#969ba0), 254 light text (#cfd8e0), 255 white, 9 the logo's light blue, 142 blue (#237cad),
// 8 and 142 the gray and blue of the comparison layers (what only A has is gray too).
function dxfHeader(ext, { num, enc, cut, pct, notes }) {
  const [ex0, ey0, ex1, ey1] = ext, s = (ex1 - ex0) / LOGO.bar[0], out = [], L = "ENCABEZADO";
  const yNotes = ey1 + 1.0 * s, yFiles = ey1 + (notes.length ? 1.55 : 1.0) * s, yPct = yFiles + 0.85 * s, yb = yPct + 0.95 * s;
  const P = (u, v) => [num(ex0 + u * s), num(yb + v * s)];
  const xyz = (i, [x, y]) => `\n1${i}\n${x}\n2${i}\n${y}\n3${i}\n0`;
  const solid = (c, a, b, d, e = d) => out.push(`0\nSOLID\n8\n${L}\n62\n${c}` + xyz(0, a) + xyz(1, b) + xyz(2, d) + xyz(3, e));
  const rect = (c, [u0, v0, u1, v1]) => solid(c, P(u0, v0), P(u1, v0), P(u0, v1), P(u1, v1));
  const tris = (c, t) => { for (let i = 0; i < t.length; i += 6) solid(c, P(t[i], t[i + 1]), P(t[i + 2], t[i + 3]), P(t[i + 4], t[i + 5])); };
  // text in world units: ha 0 left, 1 center, 2 right; va 0 baseline, 2 middle
  const textW = (c, style, str, [x, y], h, ha = 0, va = 0) => out.push(`0\nTEXT\n8\n${L}\n62\n${c}\n10\n${x}\n20\n${y}\n30\n0\n40\n${num(h)}\n1\n${enc(str)}\n7\n${style}` +
    (ha || va ? `\n72\n${ha}\n73\n${va}\n11\n${x}\n21\n${y}\n31\n0` : ""));
  const text = (c, style, str, u, v, h, ha, va) => textW(c, style, str, P(u, v), h * s, ha, va);
  // bar
  rect(253, [0, 0, LOGO.bar[0], LOGO.band]);
  rect(144, [0, LOGO.band, LOGO.bar[0], LOGO.bar[1]]);
  const mid = (LOGO.band + LOGO.bar[1]) / 2;
  // logo: its drawn part 0.9 high, centered on the bar, from u = 1.598 (the bar's blue is its background)
  { const bb = LOGO.bb, k = 0.9 / (bb[3] - bb[1]), top = mid + 0.45, pix = LOGO.pix;
    for (let i = 0; i < pix.length; i += 5) rect(pix[i + 4] === 1 ? 255 : 9, [1.598 + (pix[i] - bb[0]) * k, top - (pix[i + 3] - bb[1]) * k, 1.598 + (pix[i + 2] - bb[0]) * k, top - (pix[i + 1] - bb[1]) * k]); }
  text(255, "COMPARADOR_NEGRITA", "Comparador de Planos", 11.2, mid, 0.46, 0, 2);
  // legend pill (white, round ends) with the comparison's own colors
  const pl = [21.551, 0.642, 28.25, 1.538], r = (pl[3] - pl[1]) / 2, ring = [];
  for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + Math.PI * i / 12; ring.push([pl[2] - r + r * Math.cos(a), mid + r * Math.sin(a)]); }
  for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + Math.PI * i / 12; ring.push([pl[0] + r + r * Math.cos(a), mid + r * Math.sin(a)]); }
  const cx = (pl[0] + pl[2]) / 2;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; solid(255, P(cx, mid), P(a[0], a[1]), P(b[0], b[1])); }
  rect(8, [21.983, mid - 0.053, 22.554, mid + 0.053]); text(144, "COMPARADOR", "Coincide", 22.845, mid, 0.27, 0, 2);
  rect(S.red ? 1 : 142, [25.066, mid - 0.053, 25.637, mid + 0.053]); text(144, "COMPARADOR", "Diferencia", 25.909, mid, 0.27, 0, 2);
  text(254, "COMPARADOR", PRIVACY, 43.528, mid, 0.25, 2, 2);
  // result, files and notes between the bar and the plan
  pct = fmtPct(pct);
  textW(S.red ? 1 : 142, "COMPARADOR_NEGRITA", pct, [num(ex0), num(yPct)], 0.6 * s);
  textW(8, "COMPARADOR", "Cambios aproximados", [num(ex0 + (pct.length * 0.48 + 0.4) * s), num(yPct)], 0.34 * s);
  textW(8, "COMPARADOR", stamp(), [num(ex1), num(yPct)], 0.28 * s, 2, 0);
  textW(8, "COMPARADOR", `${cut("A: " + S.A.name, 120)}     ${cut("B: " + S.B.name, 120)}`, [num(ex0), num(yFiles)], 0.28 * s); // R12 texts hold 255 characters
  if (notes.length) textW(8, "COMPARADOR", notes.join("  ·  "), [num(ex0), num(yNotes)], 0.28 * s);
  textW(8, "COMPARADOR", CREDIT, [num((ex0 + ex1) / 2), num(ey0 - 1.0 * s)], 0.28 * s, 1, 0);
  return out;
}

// DXF in A's coordinates and units. The comparison is made on the image, so every line is
// sampled along its length and cut where it changes between "coincide" and "cambio".
async function exportDxf() {
  if (!S.result || exporting || S.running || S.A.kind !== "dxf" || S.B.kind !== "dxf") return;
  if (!window.JSZip) { setStatus("No se pudo cargar el compresor ZIP. Revisa tu conexión y recarga la página."); return; }
  setExporting(true); setBusy("Preparando DXF…"); await new Promise((r) => setTimeout(r, 30));
  try {
    const { W, H } = S.frame, R = S.result, M = S.xf.m, A = S.A, B = S.B, hatch = S.hatch, notes = exportNotes();
    const toFrameA = (x, y) => [(x - A.bb[0]) * A.k + A.pad, (A.bb[3] - y) * A.k + A.pad];
    const toFrameB = (x, y) => apply(M, (x - B.bb[0]) * B.k + B.pad, (B.bb[3] - y) * B.k + B.pad);
    const toWorldA = (fx, fy) => [((fx - A.pad) / A.k + A.bb[0]) / A.f, (A.bb[3] - (fy - A.pad) / A.k) / A.f];
    const near = (mask, fx, fy) => { let n = 0; const x0 = Math.round(fx), y0 = Math.round(fy); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = x0 + dx, y = y0 + dy; if (x >= 0 && y >= 0 && x < W && y < H) n += mask[y * W + x]; } return n; };
    const ents = [], num = (v) => (Math.round(v * 1e4) / 1e4).toString();
    // non-ASCII as \U+XXXX (characters beyond U+FFFF have no such code: "?")
    const enc = (t) => t.normalize("NFC").replace(/[^\x20-\x7e]/gu, (c) => { const v = c.codePointAt(0); return v > 0xffff ? "?" : "\\U+" + v.toString(16).toUpperCase().padStart(4, "0"); });
    // shorten a text in the middle until it takes at most max characters once encoded
    const cut = (t, max = 250) => {
      if (enc(t).length <= max) return t;
      const c = [...t.normalize("NFC")]; let n = c.length, r = t;
      while (n > 0 && enc(r).length > max) { n--; const h = Math.ceil(n / 2); r = c.slice(0, h).join("") + "..." + c.slice(c.length - (n - h)).join(""); }
      return r;
    };
    const inFrame = (fx, fy) => fx >= 0 && fy >= 0 && fx <= W && fy <= H;
    const pline = (layer, pts) => {
      if (pts.length < 2) return;
      if (pts.length === 2) { ents.push(`0\nLINE\n8\n${layer}\n10\n${num(pts[0][0])}\n20\n${num(pts[0][1])}\n30\n0\n11\n${num(pts[1][0])}\n21\n${num(pts[1][1])}\n31\n0`); return; }
      let t = `0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n0\n10\n0\n20\n0\n30\n0`;
      for (const p of pts) t += `\n0\nVERTEX\n8\n${layer}\n10\n${num(p[0])}\n20\n${num(p[1])}\n30\n0`;
      ents.push(t + `\n0\nSEQEND\n8\n${layer}`);
    };
    // split one primitive into runs of "changed" / "same", in world units of A. Only what lies in the
    // compared area is written, as on the page (a B drawn beyond A's sheet was not compared there).
    const runs = (pts, toFrame, chg, keepSame, layerChg) => {
      let cur = null, curCls = null; const flush = () => { if (cur && cur.length > 1) { if (curCls) pline(layerChg, cur); else if (keepSame) pline("COINCIDE", cur); } };
      for (let i = 0; i < pts.length - 1; i++) {
        const p = toFrame(pts[i][0], pts[i][1]), q = toFrame(pts[i + 1][0], pts[i + 1][1]);
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 1.5));
        for (let j = i === 0 ? 0 : 1; j <= n; j++) {
          const fx = p[0] + (q[0] - p[0]) * j / n, fy = p[1] + (q[1] - p[1]) * j / n;
          if (!inFrame(fx, fy)) { flush(); cur = null; curCls = null; continue; }
          const c = near(chg, fx, fy), s = near(R.com, fx, fy);
          const cls = c > s ? true : s > 0 ? false : curCls ?? false;
          // keep the vertices and the points where the class switches; a switch point ends one run and starts the next
          if (!cur) { cur = [toWorldA(fx, fy)]; curCls = cls; }
          else if (cls === curCls) { if (j === n) cur.push(toWorldA(fx, fy)); }
          else { const w = toWorldA(fx, fy); cur.push(w); flush(); cur = [w]; curCls = cls; }
        }
      }
      flush();
    };
    const textEnt = (layer, D, p, toFrame) => {
      const lines = p.s.split("\n");
      const [fx, fy] = toFrame(p.p[0], p.p[1]); const [wx, wy] = toWorldA(fx, fy);
      const hh = p.h * D.k * scaleOf(D === A ? I : M) / A.k / A.f; // height in A's units
      const rot = (p.rot - (D === A ? 0 : Math.atan2(M[1], M[0]))) * 180 / Math.PI;
      // MTEXT lines hang from their attachment point (top, middle or bottom), one line every 1.4 heights,
      // as the page draws them; each line is a TEXT aligned by its top
      const lh = hh * 1.4, y0 = !p.multi ? 0 : p.va === 3 ? 0 : p.va === 2 ? -lh * lines.length / 2 : -lh * lines.length;
      lines.forEach((s, i) => {
        if (!s.trim()) return;
        const oy = -(y0 + i * lh), x = wx - oy * Math.sin(rot * Math.PI / 180), y = wy + oy * Math.cos(rot * Math.PI / 180);
        const ha = p.ha || 0, va = p.multi ? 3 : p.va || 0, al = ha || va;
        ents.push(`0\nTEXT\n8\n${layer}\n10\n${num(x)}\n20\n${num(y)}\n30\n0\n40\n${num(hh)}\n1\n${enc(cut(s))}\n50\n${num(rot)}` + (al ? `\n72\n${ha}\n73\n${va}\n11\n${num(x)}\n21\n${num(y)}\n31\n0` : ""));
      });
    };
    // Texts: one at the same place in A and B (same height and angle) is unchanged when it says the
    // same thing and changed when it does not ("REV 0" -> "REV 1"), however few pixels that moves.
    // The others are judged by how much of their drawn letters is red.
    const txt = (D, toFrame) => D.prims.filter((p) => p.t === "x").map((p) => {
      const [x, y] = toFrame(p.p[0], p.p[1]);
      return { p, x, y, h: p.h * D.k * (D === A ? 1 : scaleOf(M)), r: p.rot - (D === A ? 0 : Math.atan2(M[1], M[0])), key: p.s.toLowerCase().replace(/\s+/g, "") };
    });
    const tA = txt(A, toFrameA), tB = txt(B, toFrameB), verdict = new Map();
    const cell = Math.max(32, ...tA.map((t) => t.h * 0.6 + 2)), grid = new Map(), gk = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
    for (const t of tB) { const g = gk(t.x, t.y); if (!grid.has(g)) grid.set(g, []); grid.get(g).push(t); }
    for (const same of [true, false]) for (const a of tA) {
      if (verdict.has(a.p)) continue;
      const gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell);
      let best = null, bd = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const b of grid.get(gx + dx + "," + (gy + dy)) || []) {
        if (verdict.has(b.p) || (b.key === a.key) !== same || b.h / a.h > 1.33 || a.h / b.h > 1.33 || Math.abs(Math.sin(b.r - a.r)) > 0.05 || Math.cos(b.r - a.r) < 0) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y); if (d < 0.6 * a.h + 2 && d < bd) { bd = d; best = b; }
      }
      if (best) { verdict.set(a.p, !same); verdict.set(best.p, !same); }
    }
    // letter boxes the page drew for each text (plan px), in frame px
    const boxes = new Map();
    for (const [D, m] of [[A, I], [B, M]]) for (const t of D.text || []) if (t.p) {
      const c = t.c.map((q) => apply(m, q[0], q[1])), b = [Math.min(...c.map((q) => q[0])), Math.min(...c.map((q) => q[1])), Math.max(...c.map((q) => q[0])), Math.max(...c.map((q) => q[1]))];
      if (!boxes.has(t.p)) boxes.set(t.p, []); boxes.get(t.p).push(b);
    }
    const textChanged = (p, chg) => {
      if (verdict.has(p)) return verdict.get(p);
      let c = 0, s = 0;
      for (const b of boxes.get(p) || []) {
        for (let y = Math.max(0, Math.floor(b[1])); y < Math.min(H, Math.ceil(b[3])); y++)
          for (let x = Math.max(0, Math.floor(b[0])); x < Math.min(W, Math.ceil(b[2])); x++) { c += chg[y * W + x]; s += R.com[y * W + x]; }
      }
      return c > s * 0.5 && c > 3;
    };
    let k = 0;
    for (const [D, toFrame, chg, layer, keepSame] of [[A, toFrameA, R.rem, "ELIMINADO_A", false], [B, toFrameB, R.add, "AGREGADO_B", true]]) {
      for (const p of D.prims) {
        if (!shown(p) || (!hatch && p.hl)) { /* left out by a switch */ }
        else if (p.t === "h") { if (hatch || p.keep) for (const L of p.loops) runs([...L, L[0]], toFrame, chg, keepSame, layer); }
        else if (p.t === "p") runs(p.pts, toFrame, chg, keepSame, layer);
        else if (!inFrame(...toFrame(p.p[0], p.p[1]))) { /* outside the compared area */ }
        else if (textChanged(p, chg)) textEnt(layer, D, p, toFrame);
        else if (keepSame) textEnt("COINCIDE", D, p, toFrame);
        if (++k % 4000 === 0) { setBusy(`Preparando DXF… ${Math.round(k / (A.prims.length + B.prims.length) * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
      }
    }
    // the page's header above the plan and the credit below it, as wide as the comparison
    const tl = toWorldA(0, 0), br = toWorldA(W, H);
    ents.push(...dxfHeader([tl[0], br[1], br[0], tl[1]], { num, enc, cut, pct: R.pct, notes }));
    const layers = [["COINCIDE", 8], ["ELIMINADO_A", 8], ["AGREGADO_B", S.red ? 1 : 142], ["ENCABEZADO", 7]];
    const styles = [["STANDARD", "txt"], ["COMPARADOR", "arial.ttf"], ["COMPARADOR_NEGRITA", "arialbd.ttf"]];
    // R12 has no units variable: say in a comment which units the coordinates are in (A's)
    const uName = { 1: "pulgadas", 2: "pies", 4: "milimetros", 5: "centimetros", 6: "metros", 7: "kilometros", 9: "micropulgadas", 10: "yardas", 14: "decimetros" }[A.dxf.header && A.dxf.header["$INSUNITS"]] || "las mismas del plano A (sin unidades declaradas)";
    const head = ["999", "Comparacion de planos. Coordenadas del plano A. Unidades: " + uName,
      "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "0", "ENDSEC",
      "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LTYPE", "70", "1", "0", "LTYPE", "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.0", "0", "ENDTAB",
      "0", "TABLE", "2", "LAYER", "70", String(layers.length),
      ...layers.flatMap(([n, c]) => ["0", "LAYER", "2", n, "70", "0", "62", String(c), "6", "CONTINUOUS"]),
      "0", "ENDTAB", "0", "TABLE", "2", "STYLE", "70", String(styles.length),
      ...styles.flatMap(([n, f]) => ["0", "STYLE", "2", n, "70", "0", "40", "0.0", "41", "1.0", "50", "0.0", "71", "0", "42", "2.5", "3", f, "4", ""]),
      "0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"].join("\n");
    const dxfText = head + "\n" + ents.join("\n") + "\n0\nENDSEC\n0\nEOF\n";
    // the .dxf itself; where the viewer does not accept .dxf files (the Claude page), inside a .zip
    await offerFile(exportName() + ".dxf", new Blob([dxfText], { type: "application/dxf" }), async () => {
      setBusy("Comprimiendo DXF…");
      const zip = new window.JSZip();
      zip.file(exportName() + ".dxf", dxfText);
      return [exportName() + "_dxf.zip", await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } })];
    });
  } catch (e) { console.error(e); setStatus("No se pudo generar el DXF: " + (e.message || e)); }
  finally { setExporting(false); setBusy(null); }
}
$("dlPdf").onclick = exportPdf;
$("dlDxf").onclick = exportDxf;

// ---------- pipeline ----------
let runId = 0;
// Letters drawn in a plan, in frame pixels. null when the plan has texts but none were drawn as
// letters (for example text made of lines): then no typeface change is ignored.
function glyphs(c, D) {
  const { W, H } = S.frame, g = inkMask(c, W, H);
  return D.lines.length && !g.includes(1) ? null : g;
}
// While a comparison runs, the downloads and the alignment dialog wait for it.
function setRunning(on) {
  S.running = on;
  if (on) $("dlPdf").disabled = $("dlDxf").disabled = $("alignBtn").disabled = true;
  else { exportButtons(); $("alignBtn").disabled = false; }
}
async function run({ rerender = false, realign = false, keepAlign = false } = {}) {
  if (!S.A || !S.B) { if (S.A || S.B) setStatus("Falta cargar el plano " + (S.A ? "B" : "A") + "."); return; }
  const id = ++runId;
  cancelRenders(); detailId++; clearDetail();
  setBusy("Comparando…"); setRunning(true);
  if (rerender) S.stale = true; // a run that is replaced before drawing leaves the redraw to the next one
  await new Promise((r) => setTimeout(r, 30));
  try {
    let full = null; // whole plans (texts and axes drawn), for the automatic alignment when a switch leaves them out
    if (S.stale || !S.rasterA) {
      if (!S.annot && (realign || !S.xf || (S.xf.mode === "auto" && !keepAlign))) {
        full = await rasterize(true);
        if (id !== runId) return;
      }
      const [a, b] = await rasterize();
      if (id !== runId) return;
      S.rasterA = a; S.rasterB = b; S.stale = false;
      S.frame = { W: Math.max(a.width, b.width), H: Math.max(a.height, b.height) };
      S.maskA = inkMask(padTo(a, S.frame.W, S.frame.H), S.frame.W, S.frame.H);
      S.glyphA = glyphs(padTo(a.text, S.frame.W, S.frame.H), S.A); a.text = null;
      realign = realign || !S.xf || (S.xf.mode === "auto" && !keepAlign) || S.xf.res !== S.frame.W;
    }
    if (realign) { const [ra, rb] = full || [S.rasterA, S.rasterB]; S.autoXf = autoAlign(ra, rb, S.frame.W, S.frame.H); S.xf = { mode: "auto", m: S.autoXf.slice(), res: S.frame.W }; }
    if (!(await reconcileFills(id))) return;
    S.bWarp = warp(S.rasterB, S.xf.m, S.frame.W, S.frame.H);
    S.glyphB = glyphs(warp(S.rasterB.text, S.xf.m, S.frame.W, S.frame.H), S.B);
    compare();
    $("empty").hidden = true;
  } catch (e) {
    // a run replaced by a newer one (a switch, another file) ends quietly
    if (id !== runId || (e && e.name === "RenderingCancelledException")) return;
    console.error(e); setStatus(e.message || String(e));
    showError("No se pudo comparar: " + (e.message || e));
  } finally { if (id === runId) { setBusy(null); setRunning(false); } }
}

// ---------- viewer ----------
class Viewer {
  constructor(el, opts = {}) {
    this.el = el; this.opts = opts; this.s = 1; this.tx = 0; this.ty = 0; this.c = null; this.marks = [];
    this.content = document.createElement("div"); this.content.className = "content"; this.content.hidden = true; el.appendChild(this.content);
    this.mlayer = document.createElement("div"); this.mlayer.className = "markers"; el.appendChild(this.mlayer);
    this.sel = document.createElement("div"); this.sel.className = "selrect"; this.sel.hidden = true; el.appendChild(this.sel);
    this.mode = "pan";
    el.addEventListener("wheel", (e) => { e.preventDefault(); const r = el.getBoundingClientRect(); this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    const pts = new Map(); let down = null, pinch = null;
    el.addEventListener("pointerdown", (e) => {
      if (!this.c || e.target.closest(".errorview, .empty")) return; // buttons on the loica screens get their own clicks
      el.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2) { const [p, q] = [...pts.values()]; pinch = { d: Math.hypot(p[0] - q[0], p[1] - q[1]) }; down = null; this.sel.hidden = true; return; }
      down = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false }; if (this.mode === "pan") el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pts.size === 2) {
        const [p, q] = [...pts.values()], d = Math.hypot(p[0] - q[0], p[1] - q[1]), r = el.getBoundingClientRect();
        this.zoomAt((p[0] + q[0]) / 2 - r.left, (p[1] + q[1]) / 2 - r.top, d / pinch.d); pinch.d = d; return;
      }
      if (!down) return; const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 4) down.moved = true;
      if (this.mode === "rect") {
        const r = el.getBoundingClientRect();
        Object.assign(this.sel.style, { left: Math.min(down.x, e.clientX) - r.left + "px", top: Math.min(down.y, e.clientY) - r.top + "px", width: Math.abs(dx) + "px", height: Math.abs(dy) + "px" });
        this.sel.hidden = false;
      } else { this.tx = down.tx + dx; this.ty = down.ty + dy; if (down.moved) this.touched = true; this.apply(); }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pinch) { if (pts.size < 2) pinch = null; return; }
      if (!down) return; el.classList.remove("dragging"); this.sel.hidden = true;
      if (this.mode === "rect" && down.moved && this.opts.onRect) {
        const a = this.toFrame(down.x, down.y), b = this.toFrame(e.clientX, e.clientY);
        this.opts.onRect([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
      } else if (!down.moved && this.opts.onClick) this.opts.onClick(this.toFrame(e.clientX, e.clientY));
      down = null;
    };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    new ResizeObserver(() => { if (this.c && !this.touched) this.fit(); else this.apply(); }).observe(el);
  }
  setCanvas(c) {
    const same = this.c && this.c.width === c.width && this.c.height === c.height;
    if (this.c !== c) { if (this.c) this.c.remove(); this.content.prepend(c); this.c = c; }
    this.content.style.width = c.width + "px"; this.content.style.height = c.height + "px";
    this.content.hidden = false;
    if (!same) this.fit(); else this.apply();
  }
  fit() {
    if (!this.c) return; const w = this.el.clientWidth, h = this.el.clientHeight - (this.opts.padBottom || 0); // keep clear of the credit line
    this.s = Math.min(w / this.c.width, h / this.c.height) * 0.94; this.tx = (w - this.c.width * this.s) / 2; this.ty = (h - this.c.height * this.s) / 2; this.touched = false; this.apply();
  }
  zoomAt(x, y, f) { const ns = Math.min(MAX_ZOOM, Math.max(0.03, this.s * f)); f = ns / this.s; this.tx = x - (x - this.tx) * f; this.ty = y - (y - this.ty) * f; this.s = ns; this.touched = true; this.apply(); }
  zoomTo(x, y, w, h) {
    const vw = this.el.clientWidth, vh = this.el.clientHeight, m = Math.max(w, h) * 0.6 + 40;
    this.s = Math.min(MAX_ZOOM, Math.min(vw / (w + 2 * m), vh / (h + 2 * m))); this.tx = vw / 2 - (x + w / 2) * this.s; this.ty = vh / 2 - (y + h / 2) * this.s; this.touched = true; this.apply();
  }
  toFrame(cx, cy) { const r = this.el.getBoundingClientRect(); return [(cx - r.left - this.tx) / this.s, (cy - r.top - this.ty) / this.s]; }
  // Smaller copies for seeing the whole plan (see pyramid()); the coarsest that still has a pixel per
  // screen pixel is shown over the full image.
  setLevels(levels) {
    for (const l of this.levels || []) l.c.remove();
    this.levels = levels; for (const l of levels) { l.c.className = "lvl"; this.content.appendChild(l.c); }
    this.apply();
  }
  apply() {
    this.content.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.s})`;
    if (this.c) this.c.style.imageRendering = this.s > 2 ? "pixelated" : "auto";
    if (this.levels) { const z = this.s * DPR(); let use = null; for (const l of this.levels) if (z * l.f <= 1.2) use = l; for (const l of this.levels) l.c.style.visibility = l === use ? "visible" : "hidden"; }
    this.mlayer.innerHTML = "";
    for (const m of this.marks) { const d = document.createElement("div"); d.className = "mk"; d.textContent = m.label; d.style.left = this.tx + m.x * this.s + "px"; d.style.top = this.ty + m.y * this.s + "px"; this.mlayer.appendChild(d); }
    if (this.opts.onView) this.opts.onView();
  }
}

const main = new Viewer($("vp"), {
  padBottom: 28,
  onView: () => scheduleDetail(),
});

// ---------- controls ----------
function setStatus(t) { $("status").textContent = $("status").title = t || ""; }
let busyEl = null;
// the red notice with the red loica on it stands alone: the welcome or error loica behind it is hidden
function setBusy(t) {
  if (t) { if (!busyEl) { busyEl = document.createElement("div"); busyEl.className = "busy"; busyEl.innerHTML = "<div></div>"; $("vp").appendChild(busyEl); } busyEl.firstChild.textContent = t; }
  else if (busyEl) { busyEl.remove(); busyEl = null; }
  $("vp").classList.toggle("is-busy", !!t);
}
function setView(v) { S.view = v; document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v)); if (S.result) { detailId++; clearDetail(); paint(); } }
document.querySelectorAll("[data-view]").forEach((b) => b.onclick = () => setView(b.dataset.view));
$("zIn").onclick = () => main.zoomAt(main.el.clientWidth / 2, main.el.clientHeight / 2, 1.6);
$("zOut").onclick = () => main.zoomAt(main.el.clientWidth / 2, main.el.clientHeight / 2, 1 / 1.6);
$("zFit").onclick = () => main.fit();
$("nmShow").onclick = () => { S.forceShow = true; clearError(); };
$("nmAlign").onclick = () => { clearError(); openManual(); };
// on the No match screen, the link stops the countdown like the screen's own button
$("alignBtn").onclick = () => { if (errKind === "nomatch") clearError(); openManual(); };
// Switches: Hatchs and Elementos de anotación, both on by default (Hatchs off leaves out only the hatch and
// fills with lines along their edge). Switching one redraws both plans and keeps the current alignment,
// also while a comparison is still running.
for (const [id, key] of [["hatchBtn", "hatch"], ["annotBtn", "annot"]]) $(id).onclick = () => {
  if (exporting) return;
  S[key] = !S[key]; $(id).setAttribute("aria-checked", S[key]);
  if (S.A && S.B) run({ rerender: true, keepAlign: true });
};
// "Ver diferencias en COLOR ROJO": only the color of the differences changes (view, legend, PDF and DXF);
// the comparison stays as it is, so the picture is just painted again.
$("redBtn").onclick = () => {
  if (exporting) return;
  S.red = !S.red; $("redBtn").setAttribute("aria-checked", S.red);
  COL_DIFF.splice(0, 3, ...(S.red ? COL_DIFF_RED : COL_DIFF_BLUE));
  legend();
  if ($("pctLbl").classList.contains("pre")) $("pctLbl").textContent = preLabel();
  if (S.result && !S.running) { cancelRenders(); detailId++; clearDetail(); paint(); }
};

// Half-size copies of a plan, down to a few hundred pixels. Each pixel keeps the darkest pixel of the
// block it stands for, so thin lines (the axes to click) do not vanish when the plan is shown whole.
function pyramid(c) {
  if (c._levels) return c._levels;
  let w = c.width, h = c.height, d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data, f = 1;
  const out = [], lum = (a, j) => 0.299 * a[j] + 0.587 * a[j + 1] + 0.114 * a[j + 2];
  while (Math.max(w, h) > 400) {
    const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2), cv = document.createElement("canvas"); cv.width = w2; cv.height = h2;
    const x2 = cv.getContext("2d", { willReadFrequently: true }), img = x2.createImageData(w2, h2), o = img.data;
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      let best = -1, bl = Infinity;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const xx = 2 * x + dx, yy = 2 * y + dy; if (xx < w && yy < h) { const j = (yy * w + xx) * 4, l = lum(d, j); if (l < bl) { bl = l; best = j; } } }
      const k = (y * w2 + x) * 4; o[k] = d[best]; o[k + 1] = d[best + 1]; o[k + 2] = d[best + 2]; o[k + 3] = 255;
    }
    x2.putImageData(img, 0, 0); f *= 2; out.push({ f, c: cv }); w = w2; h = h2; d = o;
  }
  return (c._levels = out);
}

// ---------- manual alignment dialog ----------
const pick = { A: [], B: [] };
const vA = new Viewer($("vpA"), { onClick: (p) => addPick("A", snapCorner(S.rasterA, p, SNAP_PX / vA.s)) });
const vB = new Viewer($("vpB"), { onClick: (p) => addPick("B", snapCorner(S.rasterB, p, SNAP_PX / vB.s)) });
function addPick(k, p) { if (pick[k].length >= 2) return; pick[k].push(p); refreshPicks(); }
// A click snaps to the nearest corner or crossing of lines within SNAP_PX screen pixels (Harris corner
// response on the plan's raster), so both plans get the very same point even when picked zoomed out.
// With no corner in reach the click stays where it was.
const SNAP_PX = 14;
function snapCorner(c, p, r) {
  if (!c) return p;
  r = Math.max(2, Math.min(80, r));
  const x0 = Math.max(0, Math.floor(p[0] - r) - 3), y0 = Math.max(0, Math.floor(p[1] - r) - 3);
  const x1 = Math.min(c.width, Math.ceil(p[0] + r) + 4), y1 = Math.min(c.height, Math.ceil(p[1] + r) + 4), w = x1 - x0, h = y1 - y0;
  if (w < 9 || h < 9) return p;
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 1 - (0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]) / 255;
  const xx = new Float32Array(w * h), yy = new Float32Array(w * h), xy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, gx = (g[i + 1] - g[i - 1]) / 2, gy = (g[i + w] - g[i - w]) / 2;
    xx[i] = gx * gx; yy[i] = gy * gy; xy[i] = gx * gy;
  }
  let best = null, bestV = 0;
  const s2 = 2 * (r / 1.5) ** 2;
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const dx = x0 + x + 0.5 - p[0], dy = y0 + y + 0.5 - p[1], dd = dx * dx + dy * dy;
    if (dd > r * r) continue;
    let a = 0, b = 0, cc = 0;
    for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) { const j = (y + v) * w + x + u; a += xx[j]; b += yy[j]; cc += xy[j]; }
    const R = a * b - cc * cc - 0.04 * (a + b) ** 2;
    if (R < 0.02) continue; // an ideal crossing of two thin lines gives about 0.1
    const v = R * Math.exp(-dd / s2);
    if (v > bestV) { bestV = v; best = [x0 + x + 0.5, y0 + y + 0.5]; }
  }
  return best || p;
}
function refreshPicks() {
  vA.marks = pick.A.map((p, i) => ({ x: p[0], y: p[1], label: i + 1 })); vB.marks = pick.B.map((p, i) => ({ x: p[0], y: p[1], label: i + 1 }));
  vA.apply(); vB.apply();
  $("cntA").textContent = pick.A.length + " / 2"; $("cntB").textContent = pick.B.length + " / 2";
  const same = $("sameScale").checked;
  $("dlgApply").disabled = !(pick.A.length === pick.B.length && (pick.A.length === 2 || (same && pick.A.length === 1)));
}
function openManual() {
  if (!S.rasterA || !S.xf || S.running) return;
  // a PDF and a DXF are drawn at unrelated sizes: their scale always comes from the two points
  pick.A = []; pick.B = []; $("sameScale").checked = !S.mixed && Math.abs(scaleOf(S.xf.m) - 1) < 0.005; $("dlg").showModal();
  vA.setCanvas(S.rasterA); vB.setCanvas(S.rasterB); vA.setLevels(pyramid(S.rasterA)); vB.setLevels(pyramid(S.rasterB)); vA.fit(); vB.fit(); refreshPicks();
}
$("sameScale").onchange = refreshPicks;
$("dlgReset").onclick = () => { pick.A = []; pick.B = []; refreshPicks(); };
$("dlgCancel").onclick = () => $("dlg").close();
$("dlgApply").onclick = () => {
  const [p1, p2] = pick.A, [q1, q2] = pick.B, same = $("sameScale").checked;
  let s = 1, th = 0;
  if (p2 && q2) {
    th = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
    // two points always give the scale; "same scale" only rounds a near 1 to exactly 1
    s = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
    if (same && Math.abs(s - 1) < 0.02) s = 1;
    if (Math.abs(th) < 0.002) th = 0;
  }
  const a = s * Math.cos(th), b = s * Math.sin(th);
  const e = p1[0] - (a * q1[0] - b * q1[1]), f = p1[1] - (b * q1[0] + a * q1[1]);
  S.xf = { mode: "manual", m: [a, b, -b, a, e, f], res: S.frame.W };
  $("dlg").close(); run();
};

legend();
showHome("");
loicaSync();
