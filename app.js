/**
 * SAL Noten-Scanner PWA
 *
 * Klasse 3 → Übertritt Gym/FMS (§§ 51/53)
 * Klasse 1/2 → Beförderung (§§ 41–42) + Aufstieg Leistungszug (§ 45)
 * Quelle: SGS 640.21 Laufbahnverordnung BL
 */

const SUBJECT_CATALOG = [
  { key: "D", label: "Deutsch", code: "D", aliases: ["deutsch"] },
  { key: "M", label: "Mathematik", code: "M", aliases: ["mathematik", "mathe"] },
  { key: "F", label: "Französisch", code: "F", aliases: ["französisch", "franzosisch"] },
  { key: "E", label: "Englisch", code: "E", aliases: ["englisch"] },
  { key: "Bio", label: "Biologie", code: "B", aliases: ["biologie"] },
  { key: "Ph", label: "Physik", code: "P", aliases: ["physik"] },
  { key: "Ch", label: "Chemie", code: "C", aliases: ["chemie"] },
];

/** Übertritt 3. Klasse: D/M doppelt, F/E/Bio/Ph einfach */
const UEBERTRITT_WEIGHTS = { D: 2, M: 2, F: 1, E: 1, Bio: 1, Ph: 1 };

/** Aufstieg §45 Abs. 1 lit. c – 1. Klasse */
const AUFSTIEG_WEIGHTS_Y1 = { D: 2, M: 2, Bio: 2, F: 1, E: 1 };

/** Aufstieg §45 Abs. 1 lit. d – 2. Klasse */
const AUFSTIEG_WEIGHTS_Y2 = { D: 2, M: 2, F: 1, E: 1, Bio: 1, Ch: 1 };

const UEBERTRITT_LEVELS = {
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
  A: {
    label: "Zug A",
    fms: null,
    gym: null,
  },
};

const THRESHOLD = 4.0;
const MAX_INSUFFICIENT = 3;
const AUFSTIEG_AVG_MIN = 5.0;
const AUFSTIEG_POINTS_MIN = 40;

const $ = (id) => document.getElementById(id);
const video = $("video");
const shot = $("shot");
const canvas = $("canvas");
const statusEl = $("status");
const gradeList = $("gradeList");
const statsEl = $("stats");
const modeLabel = $("modeLabel");

let stream = null;
let classYear = 3; // 1 | 2 | 3
let levelCode = "E"; // A | E | P
/** Empfehlung Klassenkonvent: null = unbekannt, true/false */
let empfehlung = null;

/** @type {Record<string, { live: number|null, zeugnis: number|null }>} */
let grades = Object.fromEntries(
  SUBJECT_CATALOG.map((s) => [s.key, { live: null, zeugnis: null }])
);

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function roundHalf(v) {
  return Math.round(Number(v) * 2) / 2;
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function fmt(n, digits) {
  if (n == null || Number.isNaN(n)) return "–";
  return Number(n).toLocaleString("de-CH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function parseGradeToken(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
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

function isOnlyGradeLine(line) {
  const t = String(line || "").trim();
  if (!t || /^(--+|–+|—+)$/.test(t)) return false;
  return /^[1-6][.,]\d{1,3}\s*\*?$/.test(t);
}

function activeWeights() {
  if (classYear === 1) return AUFSTIEG_WEIGHTS_Y1;
  if (classYear === 2) return AUFSTIEG_WEIGHTS_Y2;
  return UEBERTRITT_WEIGHTS;
}

function activeSubjects() {
  const keys = Object.keys(activeWeights());
  return SUBJECT_CATALOG.filter((s) => keys.includes(s.key));
}

function weightHint(key) {
  const w = activeWeights()[key] || 1;
  return w > 1 ? ` (×${w})` : "";
}

function matchSubjectLine(line) {
  const nLine = normalize(line);
  for (const s of SUBJECT_CATALOG) {
    // Kurscode: D-3Ed-… / C-2Ed-… — Zug-Buchstabe nicht mit Fachcode verwechseln
    const re = new RegExp("^" + s.code + "-\\d[aep][a-z]", "i");
    if (re.test(line.trim())) return s;
  }
  for (const s of SUBJECT_CATALOG) {
    if (nLine === normalize(s.label) || nLine.includes(normalize(s.label))) return s;
    if (s.aliases.some((a) => nLine === normalize(a) || nLine.startsWith(normalize(a) + " "))) {
      return s;
    }
  }
  return null;
}

function parseOcrText(text) {
  const found = Object.fromEntries(SUBJECT_CATALOG.map((s) => [s.key, null]));
  const lines = String(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const subject = matchSubjectLine(line);
    if (!subject || found[subject.key] != null) continue;

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
  }

  return found;
}

/** Klassencode z. B. (3Ed), (2Pa), (1Aa) aus OCR/Text */
function detectClassFromText(text) {
  const s = String(text || "");
  const paren = s.match(/\((\d)\s*([AEP])([a-z0-9]*)\)/i);
  if (paren) {
    return {
      year: Number(paren[1]),
      level: paren[2].toUpperCase(),
      classCode: paren[1] + paren[2].toUpperCase() + (paren[3] || ""),
    };
  }
  const course = s.match(/-\s*(\d)([AEP])([a-z])\b/i);
  if (course) {
    return {
      year: Number(course[1]),
      level: course[2].toUpperCase(),
      classCode: course[1] + course[2].toUpperCase() + course[3],
    };
  }
  return null;
}

function applyOcrLives(liveMap) {
  for (const s of SUBJECT_CATALOG) {
    const live = liveMap[s.key];
    grades[s.key] = {
      live: live,
      zeugnis: live == null ? null : roundHalf(live),
    };
  }
}

function syncModeUi() {
  document.querySelectorAll("[data-year]").forEach((b) => {
    b.classList.toggle("active", Number(b.getAttribute("data-year")) === classYear);
  });
  document.querySelectorAll("[data-level]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-level") === levelCode);
  });
  document.querySelectorAll("[data-empf]").forEach((b) => {
    const v = b.getAttribute("data-empf");
    const cur =
      empfehlung === null ? "unknown" : empfehlung ? "yes" : "no";
    b.classList.toggle("active", v === cur);
  });
  const empfRow = $("empfRow");
  if (empfRow) empfRow.classList.toggle("hidden", classYear === 3);

  if (modeLabel) {
    if (classYear === 3) {
      modeLabel.textContent =
        "Modus: Übertritt Gym/FMS (3. Klasse) · Zug " + levelCode;
    } else {
      modeLabel.textContent =
        "Modus: Beförderung & Aufstieg (" +
        classYear +
        ". Klasse, §§ 41–45) · Zug " +
        levelCode;
    }
  }
}

function gradeRowsForActive() {
  return activeSubjects().map((s) => {
    const z = grades[s.key].zeugnis;
    return {
      ...s,
      weight: activeWeights()[s.key] || 1,
      live: grades[s.key].live,
      grade: z,
      found: z != null,
    };
  });
}

function plusMinusStats(rows) {
  let plus = 0;
  let minus = 0;
  let insufficient = 0;
  for (const s of rows) {
    if (s.grade < THRESHOLD) {
      insufficient += 1;
      minus += THRESHOLD - s.grade;
    } else if (s.grade > THRESHOLD) {
      plus += s.grade - THRESHOLD;
    }
  }
  plus = round2(plus);
  minus = round2(minus);
  return {
    plus,
    minus,
    insufficient,
    plusMinusOk: minus === 0 || plus >= 2 * minus,
    countOk: insufficient <= MAX_INSUFFICIENT,
  };
}

function weightedPoints(rows, weights) {
  let points = 0;
  let slots = 0;
  for (const s of rows) {
    const w = weights[s.key] || 0;
    if (!w || s.grade == null) continue;
    points += s.grade * w;
    slots += w;
  }
  return { points: round2(points), slots };
}

/** Klasse 3: Übertritt */
function computeUebertritt(rows) {
  const profile = UEBERTRITT_LEVELS[levelCode] || UEBERTRITT_LEVELS.E;
  const missing = rows.filter((s) => !s.found);
  if (missing.length) {
    return {
      mode: "uebertritt",
      complete: false,
      missing: missing.map((s) => s.label),
      all: rows,
      profile,
    };
  }
  if (!profile.fms) {
    return {
      mode: "uebertritt",
      complete: false,
      missing: ["Übertritt Gym/FMS gilt nicht für Zug A – Zug E oder P wählen"],
      all: rows,
      profile,
    };
  }

  const avg = round2(rows.reduce((a, s) => a + s.grade, 0) / rows.length);
  const { points } = weightedPoints(rows, UEBERTRITT_WEIGHTS);
  const pm = plusMinusStats(rows);

  function track(t) {
    const avgOk = avg >= t.minAverage;
    const pointsOk = points >= t.minPoints;
    const promoOk = avgOk && pointsOk && pm.plusMinusOk && pm.countOk;
    let levelState = "fail";
    let statusLabel = "Nicht erfüllt";
    if (promoOk) {
      levelState = "ok";
      statusLabel = "Auf Kurs";
    } else if (avgOk || pointsOk) {
      levelState = "warn";
      statusLabel = "Gefährdet";
    }
    return { ...t, avgOk, pointsOk, ...pm, promoOk, levelState, statusLabel };
  }

  return {
    mode: "uebertritt",
    complete: true,
    missing: [],
    all: rows,
    average: avg,
    points,
    ...pm,
    fms: track(profile.fms),
    gym: track(profile.gym),
    profile,
  };
}

/** Klasse 1/2: Beförderung + Aufstieg */
function computeLaufbahn(rows) {
  const missing = rows.filter((s) => !s.found);
  const weights = activeWeights();
  if (missing.length) {
    return {
      mode: "laufbahn",
      complete: false,
      missing: missing.map((s) => s.label),
      all: rows,
      year: classYear,
    };
  }

  const avg = round2(rows.reduce((a, s) => a + s.grade, 0) / rows.length);
  const { points } = weightedPoints(rows, weights);
  const pm = plusMinusStats(rows);

  const befoerdert = pm.plusMinusOk && pm.countOk;

  const avgOk = avg >= AUFSTIEG_AVG_MIN;
  const pointsOk = points >= AUFSTIEG_POINTS_MIN;
  const empfOk = empfehlung === true;
  const empfKnown = empfehlung !== null;

  const conditions = [
    { key: "empf", label: "Empfehlung Klassenkonvent (§45 a)", ok: empfOk, known: empfKnown },
    { key: "avg", label: "Schnitt ≥ 5.0 (§45 b)", ok: avgOk, known: true },
    {
      key: "pts",
      label:
        "Punkte ≥ 40 (§45 " +
        (classYear === 1 ? "c, D/M/Bio ×2)" : "d, D/M ×2, +Chemie)"),
      ok: pointsOk,
      known: true,
    },
  ];
  const okCount = conditions.filter((c) => c.known && c.ok).length;
  const failKnown = conditions.filter((c) => c.known && !c.ok).length;

  // Ohne Wiederholung: alle 3 (Empfehlung muss ja sein)
  const aufstiegOhne =
    empfOk && avgOk && pointsOk
      ? "ok"
      : !empfKnown && avgOk && pointsOk
        ? "pending"
        : "fail";

  // Mit Wiederholung: mind. 2 Bedingungen
  let aufstiegMit = "fail";
  if (okCount >= 2) aufstiegMit = "ok";
  else if (!empfKnown && (avgOk || pointsOk) && okCount + 1 >= 2) aufstiegMit = "pending";

  let nextTrack = null;
  if (levelCode === "A") nextTrack = "E";
  else if (levelCode === "E") nextTrack = "P";
  else if (levelCode === "P") nextTrack = null; // bereits höchster Zug

  let nichtbefoerderungHinweis = "";
  if (!befoerdert) {
    if (classYear === 1) {
      if (levelCode === "P") {
        nichtbefoerderungHinweis =
          "§42 Abs. 1: Bei Nichtbeförderung in der 1. Klasse → definitive Zuweisung in die 2. Klasse Zug E (Wiederholung 1. Kl. in E/P in der Regel nicht möglich).";
      } else if (levelCode === "E") {
        nichtbefoerderungHinweis =
          "§42 Abs. 1: Bei Nichtbeförderung in der 1. Klasse → definitive Zuweisung in die 2. Klasse Zug A.";
      } else {
        nichtbefoerderungHinweis =
          "§42 Abs. 3: Zug A – Gespräch über Spezielle Förderung / Sonderschulung; Klassenkonvent entscheidet ggf.";
      }
    } else if (classYear === 2) {
      if (levelCode === "P") {
        nichtbefoerderungHinweis =
          "§42 Abs. 2: Grundsätzlich Wiederholung der 2. Klasse in Zug P; freiwilliger Wechsel in 3. Klasse Zug E möglich.";
      } else if (levelCode === "E") {
        nichtbefoerderungHinweis =
          "§42 Abs. 2: Grundsätzlich Wiederholung der 2. Klasse in Zug E; freiwilliger Wechsel in 3. Klasse Zug A möglich.";
      } else {
        nichtbefoerderungHinweis =
          "§42 Abs. 3: Zug A – Gespräch über Spezielle Förderung / Sonderschulung.";
      }
    }
  }

  return {
    mode: "laufbahn",
    complete: true,
    missing: [],
    all: rows,
    year: classYear,
    average: avg,
    points,
    ...pm,
    befoerdert,
    conditions,
    aufstiegOhne,
    aufstiegMit,
    nextTrack,
    nichtbefoerderungHinweis,
    weights,
  };
}

function computeAll() {
  const rows = gradeRowsForActive();
  if (classYear === 3) return computeUebertritt(rows);
  return computeLaufbahn(rows);
}

function renderGradeInputs() {
  const subjects = activeSubjects();
  gradeList.innerHTML = subjects
    .map((s) => {
      const { live, zeugnis } = grades[s.key];
      return `
    <li>
      <div class="grade-meta">
        <label for="z-${s.key}">${s.label}${weightHint(s.key)}</label>
        <small class="live-readout">
          Scan/Live: <strong>${live == null ? "–" : fmt(live, 3)}</strong>
        </small>
      </div>
      <div class="grade-edit">
        <input id="z-${s.key}" inputmode="decimal" placeholder="leer"
          value="${zeugnis == null ? "" : String(zeugnis).replace(".", ",")}"
          aria-label="${s.label} Zeugnisnote" />
        <button type="button" class="clear" data-clear="${s.key}" title="Zeugnisnote leeren">✕</button>
      </div>
    </li>`;
    })
    .join("");

  gradeList.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.id.replace(/^z-/, "");
      grades[key].zeugnis = parseGradeToken(input.value);
    });
  });

  gradeList.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-clear");
      grades[key].zeugnis = null;
      const input = $("z-" + key);
      if (input) input.value = "";
      renderStats();
    });
  });
}

function readInputs() {
  for (const s of activeSubjects()) {
    const el = $("z-" + s.key);
    if (!grades[s.key]) grades[s.key] = { live: null, zeugnis: null };
    grades[s.key].zeugnis = parseGradeToken(el && el.value);
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function pctOnScale(value, min, max) {
  return clamp01((value - min) / (max - min)) * 100;
}

function scaleBlock(opts) {
  const { title, min, max, value, marks } = opts;
  const valuePct = pctOnScale(value, min, max);
  const marksHtml = marks
    .map((m) => {
      const left = pctOnScale(m.value, min, max);
      return `
        <div class="scale-mark scale-mark--${m.kind}" style="left:${left}%">
          <span class="scale-tick"></span>
          <span class="scale-mark-label">${m.label}<br>${m.value}</span>
        </div>`;
    })
    .join("");

  return `
    <div class="scale">
      <div class="scale-head">
        <span class="scale-title">${title}</span>
        <span class="scale-value">${Number(value).toFixed(title.includes("Schnitt") ? 2 : 1)}</span>
      </div>
      <div class="scale-track" role="img" aria-label="${title}: ${value}">
        <div class="scale-fill" style="width:${valuePct}%"></div>
        ${marksHtml}
        <div class="scale-now" style="left:${valuePct}%">
          <span class="scale-now-dot"></span>
          <span class="scale-now-label">Ist</span>
        </div>
      </div>
      <div class="scale-ends"><span>${min}</span><span>${max}</span></div>
    </div>`;
}

function renderUebertrittScales(data) {
  const sameAvg = Math.abs(data.fms.minAverage - data.gym.minAverage) < 0.05;
  const avgMarks = sameAvg
    ? [{ kind: "both", label: "FMS/Gym", value: data.fms.minAverage }]
    : [
        { kind: "fms", label: "FMS", value: data.fms.minAverage },
        { kind: "gym", label: "Gym", value: data.gym.minAverage },
      ];
  return `
    <div class="scales" style="grid-column:1/-1">
      ${scaleBlock({
        title: "Notenschnitt",
        min: 3.5,
        max: 6,
        value: data.average,
        marks: avgMarks,
      })}
      ${scaleBlock({
        title: "Punktetotal (Übertritt)",
        min: 28,
        max: 48,
        value: data.points,
        marks: [
          { kind: "fms", label: "FMS", value: data.fms.minPoints },
          { kind: "gym", label: "Gym", value: data.gym.minPoints },
        ],
      })}
      <div class="scale-legend">
        <span><i class="lg fms"></i> FMS</span>
        <span><i class="lg gym"></i> Gym</span>
        <span><i class="lg now"></i> Ist</span>
      </div>
    </div>`;
}

function renderLaufbahnScales(data) {
  return `
    <div class="scales" style="grid-column:1/-1">
      ${scaleBlock({
        title: "Notenschnitt (Aufstieg)",
        min: 3.5,
        max: 6,
        value: data.average,
        marks: [{ kind: "gym", label: "Aufstieg", value: AUFSTIEG_AVG_MIN }],
      })}
      ${scaleBlock({
        title: "Punktesumme Aufstieg (§45)",
        min: 28,
        max: 48,
        value: data.points,
        marks: [{ kind: "fms", label: "Min.", value: AUFSTIEG_POINTS_MIN }],
      })}
      <div class="scale-legend">
        <span><i class="lg gym"></i> Schnitt ≥ 5.0</span>
        <span><i class="lg fms"></i> Punkte ≥ 40</span>
        <span><i class="lg now"></i> Ist</span>
      </div>
    </div>`;
}

function badge(state, label) {
  const cls = state === "ok" ? "ok" : state === "pending" || state === "warn" ? "warn" : "fail";
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderStats() {
  readInputs();
  syncModeUi();
  const data = computeAll();

  if (!data.complete) {
    statsEl.innerHTML = `
      <div class="stat" style="grid-column:1/-1">
        <div class="k">Status</div>
        <div class="v">${badge("warn", "Unvollständig")}</div>
        <div class="k" style="margin-top:0.45rem">
          Noch offen: <strong>${(data.missing || []).join(", ") || "–"}</strong>
        </div>
      </div>`;
    return;
  }

  if (data.mode === "uebertritt") {
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
      <div class="stat" style="grid-column:1/-1">
        <div class="k">Plus/Minus zu 4.0</div>
        <div class="k" style="margin-top:0.35rem;text-transform:none;letter-spacing:0;color:var(--text)">
          +${fmt(data.plus, 1)} / −${fmt(data.minus, 1)} · ungenügend: ${data.insufficient}
          · ${data.plusMinusOk && data.countOk ? "Kompensation ok" : "Kompensation / Anzahl nicht ok"}
        </div>
      </div>
      ${renderUebertrittScales(data)}
    `;
    return;
  }

  // Laufbahn 1./2. Klasse
  const befLabel = data.befoerdert ? "Befördert (§41)" : "Nicht befördert (§41/42)";
  const ohneLabel =
    data.aufstiegOhne === "ok"
      ? "Aufstieg ohne Wiederholung möglich"
      : data.aufstiegOhne === "pending"
        ? "Numerisch ok – Empfehlung noch offen"
        : "Aufstieg ohne Wiederholung nicht erfüllt";
  const mitLabel =
    data.aufstiegMit === "ok"
      ? "Aufstieg mit Wiederholung möglich (≥2 Bed.)"
      : data.aufstiegMit === "pending"
        ? "Abhängig von Empfehlung (≥2 Bed.)"
        : "Aufstieg mit Wiederholung nicht erfüllt";

  const condHtml = data.conditions
    .map((c) => {
      const state = !c.known ? "warn" : c.ok ? "ok" : "fail";
      const mark = !c.known ? "?" : c.ok ? "✓" : "✗";
      return `<div>${mark} ${c.label}</div>`;
    })
    .join("");

  statsEl.innerHTML = `
    <div class="stat"><div class="k">Schnitt</div><div class="v">${data.average.toFixed(2)}</div></div>
    <div class="stat"><div class="k">Aufstieg-Punkte</div><div class="v">${data.points.toFixed(1)}</div></div>
    <div class="stat" style="grid-column:1/-1">
      <div class="k">Beförderung</div>
      <div class="v" style="margin-top:6px">${badge(data.befoerdert ? "ok" : "fail", befLabel)}</div>
      <div class="k" style="margin-top:0.45rem;text-transform:none;letter-spacing:0">
        ≤3 ungenügend (${data.insufficient}) · Plus ≥ 2× Minus (+${fmt(data.plus, 1)} / −${fmt(data.minus, 1)})
      </div>
      ${
        data.nichtbefoerderungHinweis
          ? `<div class="k" style="margin-top:0.55rem;text-transform:none;letter-spacing:0;color:var(--warn)">${data.nichtbefoerderungHinweis}</div>`
          : ""
      }
    </div>
    <div class="stat" style="grid-column:1/-1">
      <div class="k">Aufstieg nächster Leistungszug (§45)${
        data.nextTrack ? " → Zug " + data.nextTrack : " (bereits Zug P)"
      }</div>
      <div style="margin-top:8px;display:grid;gap:6px">
        <div>${badge(data.aufstiegOhne, ohneLabel)}</div>
        <div>${badge(data.aufstiegMit, mitLabel)}</div>
      </div>
      <div class="k" style="margin-top:0.65rem;text-transform:none;letter-spacing:0;color:var(--text);font-size:0.82rem;line-height:1.45">
        ${condHtml}
      </div>
    </div>
    ${renderLaufbahnScales(data)}
    <div class="stat" style="grid-column:1/-1">
      <div class="k">Hinweis</div>
      <div class="k" style="margin-top:0.35rem;text-transform:none;letter-spacing:0">
        Berechnung auf den für §45 genannten Fächern (1. Kl.: D/M/Bio×2, F, E · 2. Kl.: D/M×2, F, E, Bio, Chemie).
        Der volle Anhang 2 kann weitere Promotionsfächer enthalten – bitte Zeugnis vollständig prüfen.
      </div>
    </div>
  `;
}

function refreshAfterModeChange() {
  renderGradeInputs();
  renderStats();
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
  setStatus("OCR läuft…");

  try {
    const result = await Tesseract.recognize(dataUrl, "deu+eng", {
      logger: (m) => {
        if (m.status === "recognizing text" && m.progress != null) {
          setStatus("OCR… " + Math.round(m.progress * 100) + "%");
        }
      },
    });
    const text = result.data.text || "";
    const detected = detectClassFromText(text);
    if (detected && detected.year >= 1 && detected.year <= 3) {
      classYear = detected.year;
      if (detected.level) levelCode = detected.level;
    }
    const liveMap = parseOcrText(text);
    applyOcrLives(liveMap);
    const hits = Object.values(grades).filter((g) => g.live != null).length;
    $("captureCard").classList.add("hidden");
    $("resultCard").classList.remove("hidden");
    refreshAfterModeChange();
    setStatus(
      (detected
        ? "Erkannt: " + (detected.classCode || detected.year + detected.level) + ". "
        : "") +
        (hits
          ? hits + " Live-Noten. Modus bitte prüfen (Klasse / Zug)."
          : "Keine Noten erkannt – manuell eintragen."),
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

document.querySelectorAll("[data-year]").forEach((btn) => {
  btn.addEventListener("click", () => {
    classYear = Number(btn.getAttribute("data-year"));
    refreshAfterModeChange();
  });
});

document.querySelectorAll("[data-level]").forEach((btn) => {
  btn.addEventListener("click", () => {
    levelCode = btn.getAttribute("data-level");
    refreshAfterModeChange();
  });
});

document.querySelectorAll("[data-empf]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.getAttribute("data-empf");
    empfehlung = v === "unknown" ? null : v === "yes";
    renderStats();
  });
});

syncModeUi();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // Neuen SW sofort aktivieren, falls schon wartend
      if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            sw.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    }).catch(() => {});
  });

  // Einmal neu laden, wenn der neue SW die Kontrolle übernimmt
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
