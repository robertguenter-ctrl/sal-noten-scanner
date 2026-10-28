/**
 * SAL Noten-Scanner PWA – Kamera + OCR + BL-Promotionslogik
 * Rechnung immer mit kaufmännisch auf ½ gerundeten Zeugnisnoten (wie Bookmarklet).
 */

const SUBJECTS = [
  { key: "D", label: "Deutsch", doubleWeight: true, code: "D", aliases: ["deutsch"] },
  { key: "M", label: "Mathematik", doubleWeight: true, code: "M", aliases: ["mathematik", "mathe"] },
  { key: "F", label: "Französisch", doubleWeight: false, code: "F", aliases: ["französisch", "franzosisch"] },
  { key: "E", label: "Englisch", doubleWeight: false, code: "E", aliases: ["englisch"] },
  { key: "Bio", label: "Biologie", doubleWeight: false, code: "B", aliases: ["biologie"] },
  { key: "Ph", label: "Physik", doubleWeight: false, code: "P", aliases: ["physik"] },
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
/** Live-Notendurchschnitt pro Fach (null = keine Note / leer) */
let grades = Object.fromEntries(SUBJECTS.map((s) => [s.key, null]));

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

/** Kaufmännische Rundung auf ½-Note (= Zeugnisnote) */
function roundHalf(v) {
  return Math.round(Number(v) * 2) / 2;
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function fmt1(n) {
  return Number(n).toLocaleString("de-CH", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function fmt3(n) {
  return Number(n).toLocaleString("de-CH", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 3,
  });
}

function parseGradeToken(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Explizit leer / keine Note
  if (/^(--+|–+|—+|\.|n\.?\s*b\.?|disp\.?|dispensiert)$/i.test(s)) return null;
  s = s.replace(/\*/g, "").replace(",", ".");
  if (/^-+$/.test(s)) return null;
  s = s.replace(/[^\d.]/g, "");
  if (!s || s === ".") return null;
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

function isEmptyMark(text) {
  const t = normalize(text).replace(/\*/g, "");
  return !t || /^(--+|–+|—+|\.|n\.?\s*b\.?|disp|dispensiert)$/.test(t);
}

function isOnlyGradeLine(line) {
  const t = String(line || "").trim();
  if (isEmptyMark(t)) return false;
  return /^[1-6][.,]\d{1,3}\s*\*?$/.test(t);
}

function matchSubjectLine(line) {
  const nLine = normalize(line);
  // Kurscode am Anfang: D-3Ed-… / B-3Ed-… (nicht GG, eaBO, wpf…)
  for (const s of SUBJECTS) {
    const re = new RegExp("^" + s.code + "-\\d[ep][a-z]", "i");
    if (re.test(line.trim())) return s;
  }
  for (const s of SUBJECTS) {
    if (nLine === normalize(s.label) || nLine.includes(normalize(s.label))) return s;
    if (s.aliases.some((a) => nLine === normalize(a) || nLine.startsWith(normalize(a) + " "))) {
      return s;
    }
  }
  return null;
}

/**
 * Konservatives OCR-Parsing:
 * - Note nur wenn in derselben Fachzeile ODER nächste Zeile eine reine Note ist
 * - "--" / leere Markierungen → kein Treffer
 * - kein „Note irgendwo in der Nähe stehlen“ über den ganzen Text
 */
function parseOcrText(text) {
  const found = Object.fromEntries(SUBJECTS.map((s) => [s.key, null]));
  const lines = String(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const subject = matchSubjectLine(line);
    if (!subject || found[subject.key] != null) continue;

    // Leermarkierung in derselben Zeile → bewusst keine Note
    if (/(?:^|\s)(--+|–+|—+)(?:\s|$)/.test(line) && !/([1-6][.,]\d{1,3})/.test(line)) {
      continue;
    }

    const same = line.match(/([1-6][.,]\d{1,3})\s*\*?/);
    if (same) {
      const g = parseGradeToken(same[1]);
      if (g != null) found[subject.key] = g;
      continue;
    }

    const next = lines[i + 1];
    if (next && isOnlyGradeLine(next)) {
      const g = parseGradeToken(next);
      if (g != null) found[subject.key] = g;
    }
    // Sonst leer lassen – lieber manuell als falsch
  }

  return found;
}

function computePromotion(rawGrades, level) {
  const profile = LEVELS[level] || LEVELS.E;
  // Immer zuerst auf Zeugnisnote (½) runden – nie mit Rohdurchschnitt rechnen
  const present = SUBJECTS.map((s) => {
    const live = rawGrades[s.key];
    if (live == null) return { ...s, live: null, grade: null, found: false };
    const grade = roundHalf(live);
    return { ...s, live, grade, found: true };
  });
  const missing = present.filter((s) => !s.found);
  const withGrades = present.filter((s) => s.found);

  if (missing.length) {
    return {
      complete: false,
      missing: missing.map((s) => s.label),
      all: present,
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
    all: present,
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
  gradeList.innerHTML = SUBJECTS.map((s) => {
    const live = grades[s.key];
    const zeugnis = live == null ? null : roundHalf(live);
    return `
    <li>
      <div class="grade-meta">
        <label for="g-${s.key}">${s.label}${s.doubleWeight ? " (×2)" : ""}</label>
        <small class="zeugnis" data-zeugnis-for="${s.key}">
          ${
            zeugnis == null
              ? "Zeugnisnote: – (leer = keine Note)"
              : "Zeugnisnote: " + fmt1(zeugnis) + (live !== zeugnis ? " ← Live " + fmt3(live) : "")
          }
        </small>
      </div>
      <div class="grade-edit">
        <input id="g-${s.key}" inputmode="decimal" placeholder="leer"
          value="${live == null ? "" : String(live).replace(".", ",")}"
          aria-label="${s.label} Live-Note" />
        <button type="button" class="clear" data-clear="${s.key}" title="Feld leeren">✕</button>
      </div>
    </li>`;
  }).join("");

  gradeList.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.id.replace(/^g-/, "");
      grades[key] = parseGradeToken(input.value);
      updateZeugnisHint(key);
      // Noch nicht auto-berechnen bei jedem Tastendruck – nur Hinweis aktualisieren
    });
  });

  gradeList.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-clear");
      grades[key] = null;
      const input = $("g-" + key);
      if (input) input.value = "";
      updateZeugnisHint(key);
      renderStats();
    });
  });
}

function updateZeugnisHint(key) {
  const live = grades[key];
  const el = gradeList.querySelector(`[data-zeugnis-for="${key}"]`);
  if (!el) return;
  if (live == null) {
    el.textContent = "Zeugnisnote: – (leer = keine Note)";
    return;
  }
  const z = roundHalf(live);
  el.textContent =
    "Zeugnisnote: " + fmt1(z) + (live !== z ? " ← Live " + fmt3(live) : "");
}

function readInputs() {
  for (const s of SUBJECTS) {
    const el = $("g-" + s.key);
    grades[s.key] = parseGradeToken(el && el.value);
  }
}

function renderStats() {
  readInputs();
  SUBJECTS.forEach((s) => updateZeugnisHint(s.key));
  const data = computePromotion(grades, levelCode);
  if (!data.complete) {
    statsEl.innerHTML = `
      <div class="stat" style="grid-column:1/-1">
        <div class="k">Status</div>
        <div class="v"><span class="badge warn">Unvollständig</span></div>
        <div class="k" style="margin-top:0.45rem">
          Berechnung erst mit allen 6 Zeugnisnoten.<br>
          Noch offen / leer: <strong>${data.missing.join(", ")}</strong>
        </div>
      </div>`;
    return;
  }

  const roundedList = data.all
    .map((s) => `${s.label} ${fmt1(s.grade)}`)
    .join(" · ");

  const overall = data.gym.promoOk
    ? { cls: "ok", label: "Auf Kurs (Gym)" }
    : data.fms.promoOk
      ? { cls: "ok", label: "Auf Kurs (FMS)" }
      : { cls: "warn", label: "Gefährdet / nicht erfüllt" };

  statsEl.innerHTML = `
    <div class="stat"><div class="k">Schnitt (½-Noten)</div><div class="v">${data.average.toFixed(2)}</div></div>
    <div class="stat"><div class="k">Punkte (½-Noten)</div><div class="v">${data.points.toFixed(1)}</div></div>
    <div class="stat"><div class="k">Status</div><div class="v"><span class="badge ${overall.cls}">${overall.label}</span></div></div>
    <div class="stat"><div class="k">${data.profile.label}</div><div class="v" style="font-size:0.95rem">FMS ${data.fms.statusLabel}<br>Gym ${data.gym.statusLabel}</div></div>
    <div class="stat" style="grid-column:1/-1">
      <div class="k">Verwendete Zeugnisnoten</div>
      <div class="k" style="margin-top:0.35rem;text-transform:none;letter-spacing:0;font-size:0.82rem;color:var(--text)">${roundedList}</div>
    </div>
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
        ? hits +
            " Noten erkannt. Leere Fächer = keine Note (✕ zum Löschen). Rechnung nutzt ½-Zeugnisnoten."
        : "Keine Noten erkannt – Felder manuell ausfüllen. Leer lassen, wenn noch keine Note.",
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
