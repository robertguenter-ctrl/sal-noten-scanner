/**
 * SAL Noten-Scanner PWA – Kamera + OCR + BL-Promotionslogik
 * Schwellen analog zum Bookmarklet-Dashboard (Laufbahnverordnung BL).
 */

const SUBJECTS = [
  { key: "D", label: "Deutsch", doubleWeight: true, aliases: ["deutsch", "d-3"] },
  { key: "M", label: "Mathematik", doubleWeight: true, aliases: ["mathematik", "mathe", "m-3"] },
  { key: "F", label: "Französisch", doubleWeight: false, aliases: ["französisch", "franzosisch", "f-3"] },
  { key: "E", label: "Englisch", doubleWeight: false, aliases: ["englisch", "e-3"] },
  { key: "Bio", label: "Biologie", doubleWeight: false, aliases: ["biologie", "b-3"] },
  { key: "Ph", label: "Physik", doubleWeight: false, aliases: ["physik", "p-3"] },
];

const LEVELS = {
  E: {
    label: "Zug E",
    fms: { label: "FMS", minAverage: 4.5, minPoints: 36.5 },
    gym: { label: "Gymnasium", minAverage: 5.0, minPoints: 40.5 },
  },
  P: {
    label: "Zug P",
    fms: { label: "FMS", minAverage: 4.0, minPoints: 32.5 },
    gym: { label: "Gymnasium", minAverage: 4.0, minPoints: 34.5 },
  },
};

const THRESHOLD = 4.0;
const MAX_INSUFFICIENT = 3;

const $ = (id) => document.getElementById(id);
const video = $("video");
const shot = $("shot");
const canvas = $("canvas");
const statusEl = $("status");
const gradeList = $("gradeList");
const statsEl = $("stats");

let stream = null;
let levelCode = "E";
let grades = Object.fromEntries(SUBJECTS.map((s) => [s.key, null]));

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function roundHalf(v) {
  return Math.round(v * 2) / 2;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function parseGradeToken(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\*/g, "").replace(",", ".");
  if (!s || /^-+$/.test(s) || /dispens/i.test(s)) return null;
  s = s.replace(/[^\d.]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || n > 6) return null;
  return n;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sehr heuristisches OCR-Parsing der Live-SAL-Tabelle */
function parseOcrText(text) {
  const found = Object.fromEntries(SUBJECTS.map((s) => [s.key, null]));
  const lines = String(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nLine = normalize(line);
    const subject = SUBJECTS.find(
      (s) =>
        nLine.includes(normalize(s.label)) ||
        s.aliases.some((a) => nLine.includes(normalize(a))) ||
        new RegExp("^" + s.key.replace("Bio", "B").replace("Ph", "P") + "-\\d", "i").test(line)
    );
    if (!subject || found[subject.key] != null) continue;

    // Note in derselben Zeile oder der nächsten
    const same = line.match(/([1-6][.,]\d{1,3})\s*\*?/);
    const next = lines[i + 1] && lines[i + 1].match(/([1-6][.,]\d{1,3})\s*\*?/);
    const token = (same && same[1]) || (next && next[1]);
    const grade = parseGradeToken(token);
    if (grade != null) found[subject.key] = grade;
  }

  // Kurscode-Muster irgendwo im Text: "E-3Ed" … gefolgt von Note in Nähe
  const blob = text.replace(/\s+/g, " ");
  const codeMap = { B: "Bio", D: "D", E: "E", F: "F", M: "M", P: "Ph" };
  for (const [code, key] of Object.entries(codeMap)) {
    if (found[key] != null) continue;
    const re = new RegExp(code + "-\\d[EP][a-z][^0-9]{0,40}?([1-6][.,]\\d{1,3})", "i");
    const m = blob.match(re);
    if (m) found[key] = parseGradeToken(m[1]);
  }

  return found;
}

function computePromotion(rawGrades, level) {
  const profile = LEVELS[level] || LEVELS.E;
  const present = SUBJECTS.map((s) => {
    const g = rawGrades[s.key];
    if (g == null) return { ...s, grade: null, found: false };
    return { ...s, grade: roundHalf(g), liveAverage: g, found: true };
  });
  const missing = present.filter((s) => !s.found);
  const withGrades = present.filter((s) => s.found);

  if (missing.length) {
    return {
      complete: false,
      missing: missing.map((s) => s.label),
      present: withGrades,
      average: null,
      points: null,
      fms: null,
      gym: null,
      profile,
    };
  }

  const avg = round2(withGrades.reduce((a, s) => a + s.grade, 0) / withGrades.length);
  let points = 0;
  let plus = 0;
  let minus = 0;
  let insufficient = 0;
  for (const s of withGrades) {
    points += s.grade * (s.doubleWeight ? 2 : 1);
    if (s.grade < THRESHOLD) {
      insufficient += 1;
      minus += THRESHOLD - s.grade;
    } else if (s.grade > THRESHOLD) {
      plus += s.grade - THRESHOLD;
    }
  }
  points = round2(points);
  plus = round2(plus);
  minus = round2(minus);
  const plusMinusOk = minus === 0 || plus >= 2 * minus;
  const countOk = insufficient <= MAX_INSUFFICIENT;

  function track(t) {
    const avgOk = avg >= t.minAverage;
    const pointsOk = points >= t.minPoints;
    const promoOk = avgOk && pointsOk && plusMinusOk && countOk;
    let levelState = "fail";
    let label = "Nicht erfüllt";
    if (promoOk) {
      levelState = "ok";
      label = "Auf Kurs";
    } else if (avgOk || pointsOk) {
      levelState = "warn";
      label = "Gefährdet";
    }
    return { ...t, avgOk, pointsOk, plusMinusOk, countOk, promoOk, levelState, statusLabel: label };
  }

  return {
    complete: true,
    missing: [],
    present: withGrades,
    average: avg,
    points,
    plus,
    minus,
    insufficient,
    fms: track(profile.fms),
    gym: track(profile.gym),
    profile,
  };
}

function renderGradeInputs() {
  gradeList.innerHTML = SUBJECTS.map(
    (s) => `
    <li>
      <label for="g-${s.key}">${s.label}${s.doubleWeight ? " (×2)" : ""}</label>
      <input id="g-${s.key}" inputmode="decimal" placeholder="–" value="${
        grades[s.key] == null ? "" : String(grades[s.key]).replace(".", ",")
      }" />
    </li>`
  ).join("");
}

function readInputs() {
  for (const s of SUBJECTS) {
    const el = $("g-" + s.key);
    grades[s.key] = parseGradeToken(el && el.value);
  }
}

function renderStats() {
  readInputs();
  const data = computePromotion(grades, levelCode);
  if (!data.complete) {
    statsEl.innerHTML = `
      <div class="stat" style="grid-column:1/-1">
        <div class="k">Status</div>
        <div class="v"><span class="badge warn">Unvollständig</span></div>
        <div class="k" style="margin-top:0.45rem">Noch offen: ${data.missing.join(", ")}</div>
      </div>`;
    return;
  }
  const overall = data.gym.promoOk
    ? { cls: "ok", label: "Auf Kurs (Gym)" }
    : data.fms.promoOk
      ? { cls: "ok", label: "Auf Kurs (FMS)" }
      : { cls: "warn", label: "Gefährdet / nicht erfüllt" };

  statsEl.innerHTML = `
    <div class="stat"><div class="k">Schnitt</div><div class="v">${data.average.toFixed(2)}</div></div>
    <div class="stat"><div class="k">Punkte</div><div class="v">${data.points.toFixed(1)}</div></div>
    <div class="stat"><div class="k">Status</div><div class="v"><span class="badge ${overall.cls}">${overall.label}</span></div></div>
    <div class="stat"><div class="k">${data.profile.label}</div><div class="v" style="font-size:0.95rem">FMS ${data.fms.statusLabel}<br>Gym ${data.gym.statusLabel}</div></div>
  `;
}

async function startCamera() {
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = stream;
    video.classList.remove("hidden");
    shot.classList.add("hidden");
    $("snap").disabled = false;
    setStatus("Kamera aktiv – Tabelle im Rahmen halten.", "ok");
  } catch (err) {
    setStatus("Kamera nicht verfügbar: " + err.message, "error");
  }
}

async function takePhotoAndScan() {
  if (!stream) return;
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  shot.src = dataUrl;
  shot.classList.remove("hidden");
  video.classList.add("hidden");
  $("snap").disabled = true;
  setStatus("OCR läuft… (kann einige Sekunden dauern)");

  try {
    const result = await Tesseract.recognize(dataUrl, "deu+eng", {
      logger: (m) => {
        if (m.status === "recognizing text" && m.progress != null) {
          setStatus("OCR… " + Math.round(m.progress * 100) + "%");
        }
      },
    });
    const text = result.data.text || "";
    grades = parseOcrText(text);
    const hits = Object.values(grades).filter((g) => g != null).length;
    renderGradeInputs();
    $("captureCard").classList.add("hidden");
    $("resultCard").classList.remove("hidden");
    renderStats();
    setStatus(
      hits
        ? hits + " Noten erkannt – bitte prüfen und korrigieren."
        : "Keine Noten erkannt – Werte manuell eintragen.",
      hits ? "ok" : "error"
    );
  } catch (err) {
    setStatus("OCR fehlgeschlagen: " + err.message, "error");
    $("snap").disabled = false;
  }
}

function resetScan() {
  $("resultCard").classList.add("hidden");
  $("captureCard").classList.remove("hidden");
  shot.classList.add("hidden");
  video.classList.remove("hidden");
  $("snap").disabled = !stream;
  setStatus(stream ? "Bereit für ein neues Foto." : "Kamera starten.");
}

$("startCam").addEventListener("click", startCamera);
$("snap").addEventListener("click", takePhotoAndScan);
$("rescan").addEventListener("click", resetScan);
$("recalc").addEventListener("click", renderStats);

document.querySelectorAll("[data-level]").forEach((btn) => {
  btn.addEventListener("click", () => {
    levelCode = btn.getAttribute("data-level");
    document.querySelectorAll("[data-level]").forEach((b) => b.classList.toggle("active", b === btn));
    renderStats();
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
