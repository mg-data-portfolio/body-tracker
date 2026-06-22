import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const STORAGE_KEY = "body-tracker-entries";
const SETTINGS_KEY = "body-tracker-settings";
const PROFILE_KEY = "body-tracker-profile";
const CYCLE_KEY = "body-tracker-cycle";
const GOAL_KEY = "body-tracker-goal";
const PHASEHIST_KEY = "body-tracker-phasehist";
const THEME_KEY = "body-tracker-theme";

// Structural color tokens. Accent colors (phase/macro) are left as literal hex
// since they read well on both themes.
const THEME_CSS = `
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0f1117;
  --surface: #161b27;
  --surface-2: #1a1f2e;
  --border: #1f2937;
  --border-strong: #374151;
  --text-faint: #2d3748;
  --text-dim: #4b5563;
  --text-muted: #6b7280;
  --text-soft: #9ca3af;
  --text-bright: #cbd5e1;
  --text: #e5e7eb;
  --shadow: rgba(0,0,0,0.5);
  --overlay: rgba(0,0,0,0.6);
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f4f5f7;
  --surface: #ffffff;
  --surface-2: #eef1f6;
  --border: #e2e6ec;
  --border-strong: #cbd2dc;
  --text-faint: #c4cad3;
  --text-dim: #9aa3b0;
  --text-muted: #6b7280;
  --text-soft: #4b5563;
  --text-bright: #374151;
  --text: #111827;
  --shadow: rgba(15,23,42,0.14);
  --overlay: rgba(15,23,42,0.4);
}
`;

// Bespoke profile defaults
const DEFAULT_PROFILE = {
  dob: "1997-08-01",
  heightCm: 180.3,   // 5 ft 11 in
  sex: "male",
  activity: 1.55,    // moderately active (3 workouts/wk + ~8k steps)
};

const ACTIVITY_LEVELS = [
  { value: 1.2, label: "Sedentary", sub: "desk job, no exercise" },
  { value: 1.375, label: "Lightly active", sub: "light exercise 1–3×/wk" },
  { value: 1.55, label: "Moderately active", sub: "exercise 3–5×/wk" },
  { value: 1.725, label: "Very active", sub: "hard exercise 6–7×/wk" },
];

const REVIEW_DAYS = 14;        // 2-week locked review cycle
const ADJUST_STEP = 150;       // standard nudge (kcal)

function ageFromDOB(dob) {
  if (!dob) return null;
  const b = new Date(dob + "T00:00:00");
  if (isNaN(b)) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

// Mifflin-St Jeor BMR → baseline TDEE via activity multiplier.
function calcBaselineTDEE(profile, weightKg) {
  if (!profile || !weightKg) return null;
  const age = ageFromDOB(profile.dob);
  if (age == null || !profile.heightCm) return null;
  const s = profile.sex === "female" ? -161 : 5;
  const bmr = 10 * weightKg + 6.25 * profile.heightCm - 5 * age + s;
  return Math.round(bmr * (profile.activity || 1.55));
}

// Single-device persistence via localStorage. JSON in/out, fails safely.
const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) { return false; }
  },
};

// Local-date YYYY-MM-DD (avoids UTC off-by-one near midnight in +UTC zones like Ireland in summer)
const formatDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const today = formatDate(new Date());

// Add N days (can be negative) to a YYYY-MM-DD string, returning a YYYY-MM-DD string.
const addDaysStr = (dateStr, n) => {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return formatDate(d);
};

const RANGES = {
  week: { label: "Week", days: 7 },
  month: { label: "Month", days: 30 },
  quarter: { label: "Quarter", days: 91 },
  year: { label: "Year", days: 365 },
};

const REPORT_RANGES = {
  week: { label: "Week", days: 7 },
  month: { label: "Month", days: 30 },
  quarter: { label: "Quarter", days: 91 },
  custom: { label: "Custom", days: null },
};

// Linear regression slope (per day) for a trend line; returns {slope, intercept} or null
function linReg(points) {
  const n = points.length;
  if (n < 2) return null;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const mx = avg(xs), my = avg(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}
const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

function parseEntry(e) {
  return {
    calories: e.calories != null ? Number(e.calories) : null,
    weight: e.weight != null ? Number(e.weight) : null,
    bf: e.bf != null ? Number(e.bf) : null,
    protein: e.protein != null ? Number(e.protein) : null,
  };
}

// TDEE via regression of weight-change rate over a window of N days.
// Returns { tdee, days, weightPoints, caloriePoints } or null.
// dated: array of { date, ts, calories, weight } sorted ascending.
function calcTDEEWindow(dated, windowDays, asOfTs = Date.now()) {
  const cutoff = asOfTs - windowDays * 86400000;
  const win = dated.filter(d => d.ts >= cutoff && d.ts <= asOfTs);
  const cals = win.map(d => d.calories).filter(v => v != null);
  const wPts = win.filter(d => d.weight != null).map(d => ({ x: d.ts, y: d.weight }));
  // Need enough signal: ≥7 calorie days and ≥4 weight readings spanning ≥10 days
  if (cals.length < 7 || wPts.length < 4) return null;
  const spanDays = (wPts[wPts.length - 1].x - wPts[0].x) / 86400000;
  if (spanDays < 10) return null;
  const reg = linReg(wPts);
  if (!reg) return null;
  const avgCals = avg(cals);
  const dailyKgChange = reg.slope * 86400000; // slope is kg per ms
  const dailySurplus = dailyKgChange * 7700;  // kcal/day implied by weight trend
  return {
    tdee: Math.round(avgCals - dailySurplus),
    days: Math.round(spanDays),
    calorieDays: cals.length,
    weightPoints: wPts.length,
  };
}

// ─── Evidence-based phase presets ───────────────────────────────────────────
// Cut:
//   Aggressive  : ~25% deficit  → max fat loss before LBM loss accelerates
//                 ~0.75–1% BW/wk. Hall et al. 2012; Helms et al. 2014 (ISSN)
//   Moderate    : ~20% deficit  → ~0.5–0.75% BW/wk. Barbalho et al. 2020
//   Conservative: ~10–15% def  → ~0.25–0.5% BW/wk. Best LBM retention
//
// Bulk:
//   Aggressive  : ~20% surplus  → ~0.5–1% BW/wk gain, higher fat accretion
//                 Haff & Triplett 2016; Slater et al. 2019
//   Moderate    : ~10% surplus  → ~0.25–0.5% BW/wk; "lean bulk" sweet spot
//   Conservative: ~5% surplus   → ~0.1–0.25% BW/wk; minimal fat gain
//                 Barbalho et al. 2020; Ribeiro et al. 2019
//
// Maintain: ±0% (Schofield/Harris-Benedict consensus)

const PHASES = {
  cut: {
    label: "Cut",
    color: "#f87171",
    magnitudes: [
      {
        id: "aggressive",
        label: "Aggressive",
        sublabel: "0.75–1% BW/wk",
        deficitPct: 0.25,
        description: "25% deficit. Maximum fat loss rate before meaningful LBM erosion. Suitable for short blocks (4–6 wks) with high protein ≥1g/lb LBM.",
        weeklyLbsLow: null, weeklyLbsHigh: null, // derived from BW
      },
      {
        id: "moderate",
        label: "Moderate",
        sublabel: "0.5–0.75% BW/wk",
        deficitPct: 0.20,
        description: "20% deficit. Best balance of speed and muscle retention for most training phases. Sustainable for 8–16 wks.",
      },
      {
        id: "conservative",
        label: "Conservative",
        sublabel: "0.25–0.5% BW/wk",
        deficitPct: 0.12,
        description: "~12% deficit. Slowest cut; highest LBM retention. Ideal when close to goal, pre-competition, or during high training volume.",
      },
    ],
  },
  maintain: {
    label: "Maintain",
    color: "#34d399",
    magnitudes: [
      {
        id: "maintain",
        label: "Maintenance",
        sublabel: "±0%",
        deficitPct: 0,
        description: "Match TDEE. Use during deload weeks, diet breaks, or body recomposition phases with a high training stimulus.",
      },
    ],
  },
  bulk: {
    label: "Bulk",
    color: "#60a5fa",
    magnitudes: [
      {
        id: "conservative",
        label: "Lean Bulk",
        sublabel: "0.1–0.25% BW/wk",
        deficitPct: -0.05,
        description: "5% surplus. Minimal fat accretion. Best for intermediates/advanced who want slow, clean mass gain over 16–24+ wks.",
      },
      {
        id: "moderate",
        label: "Moderate",
        sublabel: "0.25–0.5% BW/wk",
        deficitPct: -0.10,
        description: "10% surplus. The evidence-backed 'lean bulk' sweet spot. Good rate of hypertrophy with manageable fat gain over 12–16 wks.",
      },
      {
        id: "aggressive",
        label: "Aggressive",
        sublabel: "0.5–1% BW/wk",
        deficitPct: -0.20,
        description: "20% surplus. Faster mass gain but higher fat accretion. Best for beginners or true hardgainers. Keep blocks ≤8–12 wks.",
      },
    ],
  },
};

// ── Phase recommendation for an intermediate lifter ──
// Body-fat thresholds (male, intermediate). For female lifters add ~8-10%.
// Bulk runway under ~13% BF (Helms; lean enough that a surplus partitions well).
// Cut when >~18% BF (surplus would add mostly fat; insulin sensitivity, health markers).
// 13–18% is the flexible band — either is reasonable.
function recommendPhase(bf) {
  if (bf == null) {
    return {
      phase: null, magnitude: null,
      headline: "Log a body-fat reading to get a recommendation",
      body: "Once a 7-day body-fat average is available, this will suggest whether to bulk, cut, or maintain — aiming for a healthy, sustainable range for an intermediate lifter (roughly 10–15% BF for men).",
      tone: "var(--text-muted)",
    };
  }
  if (bf >= 18) {
    return {
      phase: "cut", magnitude: bf >= 22 ? "moderate" : "conservative",
      headline: `Recommend: Cut (${bf.toFixed(1)}% BF)`,
      body: `At ${bf.toFixed(1)}% you're above the lean range where a surplus partitions well. A cut down toward ~12–14% will improve muscle-to-fat ratio, insulin sensitivity, and give you more bulking runway afterward. ${bf >= 22 ? "A moderate deficit is appropriate at this level." : "A conservative deficit protects lean mass since you're not far off."}`,
      tone: "#f87171",
    };
  }
  if (bf <= 12) {
    return {
      phase: "bulk", magnitude: bf <= 9 ? "moderate" : "conservative",
      headline: `Recommend: Bulk (${bf.toFixed(1)}% BF)`,
      body: `At ${bf.toFixed(1)}% you're lean with good runway to add muscle. A surplus here partitions favorably toward lean mass. ${bf <= 9 ? "You can run a moderate surplus before fat gain becomes a concern." : "A lean-bulk (small surplus) keeps fat gain minimal while building."}`,
      tone: "#60a5fa",
    };
  }
  // 13–17% flexible band
  return {
    phase: "maintain", magnitude: "maintain",
    headline: `Flexible zone (${bf.toFixed(1)}% BF)`,
    body: `At ${bf.toFixed(1)}% you're in a healthy intermediate range where either direction works. Lean toward a bulk if your priority is size and strength, or a short cut if you'd rather reveal more definition first. Maintenance or a slow recomp is also reasonable here.`,
    tone: "#34d399",
  };
}

function calcTarget(tdee, phase, magnitudeId) {
  if (!tdee || !phase || !magnitudeId) return null;
  const mag = PHASES[phase]?.magnitudes.find(m => m.id === magnitudeId);
  if (!mag) return null;
  const raw = tdee * (1 - mag.deficitPct);
  return Math.round(raw / 25) * 25; // stabilize: nearest 25 kcal
}

// ── Macro recommendation (science-based; Nippard / Ethier / Helms / ISSN) ──
// Protein: 1.6–2.4 g/kg BW, higher in deficits to spare lean mass.
// Fat: 0.6 g/kg hormonal floor; 0.8–1.0 g/kg practical; lower in cuts to free calories.
// Carbs: remainder — the training-fuel lever that flexes with phase/calories.
// 4 kcal/g protein & carb, 9 kcal/g fat.
function calcMacros(targetCals, weightKg, phase, magnitudeId) {
  if (!targetCals || !weightKg) return null;
  const intensity = magnitudeId; // "aggressive" | "moderate" | "conservative" | "maintain"

  let proteinPerKg, fatPerKg;
  if (phase === "cut") {
    proteinPerKg = intensity === "aggressive" ? 2.4 : intensity === "moderate" ? 2.2 : 2.0;
    fatPerKg = 0.8; // toward the floor to preserve carbs for training
  } else if (phase === "bulk") {
    proteinPerKg = 1.8;
    fatPerKg = intensity === "aggressive" ? 1.0 : 0.9;
  } else { // maintain / recomp
    proteinPerKg = 2.0;
    fatPerKg = 0.9;
  }

  let proteinG = Math.round(weightKg * proteinPerKg);
  let fatG = Math.round(weightKg * fatPerKg);

  // Enforce hormonal fat floor (~0.6 g/kg) if remaining calories squeeze it
  const fatFloorG = Math.round(weightKg * 0.6);

  let proteinCals = proteinG * 4;
  let fatCals = fatG * 9;
  let carbCals = targetCals - proteinCals - fatCals;

  // If carbs go negative (very low calories / high BW), trim fat to floor first, then protein.
  if (carbCals < 0) {
    fatG = fatFloorG;
    fatCals = fatG * 9;
    carbCals = targetCals - proteinCals - fatCals;
    if (carbCals < 0) {
      // reduce protein to fit, but never below 1.6 g/kg
      const minProteinG = Math.round(weightKg * 1.6);
      const room = targetCals - fatCals;
      proteinG = Math.max(minProteinG, Math.floor(room / 4));
      proteinCals = proteinG * 4;
      carbCals = Math.max(0, targetCals - proteinCals - fatCals);
    }
  }

  const carbsG = Math.max(0, Math.round(carbCals / 4));
  // Recompute cals from rounded grams for display consistency
  proteinCals = proteinG * 4;
  fatCals = fatG * 9;
  carbCals = carbsG * 4;
  const totalCals = proteinCals + fatCals + carbCals;

  return {
    proteinG, fatG, carbsG,
    proteinCals, fatCals, carbCals, totalCals,
    proteinPerKg: (proteinG / weightKg),
    fatPerKg: (fatG / weightKg),
    pctProtein: Math.round((proteinCals / totalCals) * 100),
    pctFat: Math.round((fatCals / totalCals) * 100),
    pctCarbs: Math.round((carbCals / totalCals) * 100),
  };
}

function weeklyRateLabel(phase, magnitudeId, avgWeight) {
  if (!avgWeight || phase === "maintain") return null;
  const mag = PHASES[phase]?.magnitudes.find(m => m.id === magnitudeId);
  if (!mag) return null;
  const pct = phase === "cut"
    ? { low: mag.deficitPct === 0.25 ? 0.0075 : mag.deficitPct === 0.20 ? 0.005 : 0.0025,
        high: mag.deficitPct === 0.25 ? 0.01 : mag.deficitPct === 0.20 ? 0.0075 : 0.005 }
    : { low: mag.deficitPct === -0.05 ? 0.001 : mag.deficitPct === -0.10 ? 0.0025 : 0.005,
        high: mag.deficitPct === -0.05 ? 0.0025 : mag.deficitPct === -0.10 ? 0.005 : 0.01 };
  const lo = (avgWeight * pct.low).toFixed(2);
  const hi = (avgWeight * pct.high).toFixed(2);
  return phase === "cut" ? `−${lo}–${hi} kg/wk` : `+${lo}–${hi} kg/wk`;
}

// Signed goal rate in kg/week (negative for cut), midpoint of the band.
function goalRatePerWeek(phase, magnitudeId, weightKg) {
  if (!weightKg || phase === "maintain") return null;
  const mag = PHASES[phase]?.magnitudes.find(m => m.id === magnitudeId);
  if (!mag) return null;
  const pct = phase === "cut"
    ? { low: mag.deficitPct === 0.25 ? 0.0075 : mag.deficitPct === 0.20 ? 0.005 : 0.0025,
        high: mag.deficitPct === 0.25 ? 0.01 : mag.deficitPct === 0.20 ? 0.0075 : 0.005 }
    : { low: mag.deficitPct === -0.05 ? 0.001 : mag.deficitPct === -0.10 ? 0.0025 : 0.005,
        high: mag.deficitPct === -0.05 ? 0.0025 : mag.deficitPct === -0.10 ? 0.005 : 0.01 };
  const mid = weightKg * (pct.low + pct.high) / 2;
  return phase === "cut" ? -mid : mid;
}

// Delta badge: compare 7d avg calories to target
function deltaBadge(avgCals, target, phase) {
  if (!avgCals || !target) return null;
  const diff = Math.round(avgCals - target);
  const over = diff > 0;
  const sign = over ? "+" : "";
  let color = "var(--text-muted)";
  if (phase === "cut") color = over ? "#f87171" : "#34d399";
  if (phase === "bulk") color = over ? "#34d399" : "#f87171";
  if (phase === "maintain") color = Math.abs(diff) <= 100 ? "#34d399" : "#f87171";
  return { label: `${sign}${diff} kcal vs target`, color };
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", background: "var(--bg)",
  border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px",
  color: "var(--text)", fontSize: 13, fontVariantNumeric: "tabular-nums",
  outline: "none",
};

const labelStyle = {
  display: "block", fontSize: 9, letterSpacing: "0.08em",
  textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600, marginBottom: 6,
};

export default function App() {
  const [entries, setEntries] = useState({});
  const [activeDate, setActiveDate] = useState(today);
  const [morningForm, setMorningForm] = useState({ weight: "", bf: "" });
  const [eveningForm, setEveningForm] = useState({ calories: "", protein: "" });
  const [loaded, setLoaded] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [phase, setPhase] = useState("cut");
  const [magnitude, setMagnitude] = useState("moderate");
  const [view, setView] = useState("log");
  const [range, setRange] = useState("month");
  const [reportRange, setReportRange] = useState("month");
  const [reportCustomStart, setReportCustomStart] = useState("");
  const [reportCustomEnd, setReportCustomEnd] = useState(today);
  const [metric, setMetric] = useState("weight");
  const [tdeeWindow, setTdeeWindow] = useState(14);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [profileOpen, setProfileOpen] = useState(false);
  const [theme, setTheme] = useState("dark");
  // Styled confirm dialog: { title, message, actions: [{label, style, onClick}] } | null
  const [dialog, setDialog] = useState(null);
  // Adjustment cycle: { anchorDate, lockedTarget } | null
  const [cycle, setCycle] = useState(null);
  // Goal: { weightKg, date } | null
  const [goal, setGoal] = useState(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [reviewConfirming, setReviewConfirming] = useState(false);
  // Phase history: array of { date, phase, magnitude }
  const [phaseHist, setPhaseHist] = useState([]);
  const fileInputRef = useRef(null);
  const dateInputRef = useRef(null);

  useEffect(() => {
    try {
      const e = store.get(STORAGE_KEY);
      if (e) setEntries(e);
      const s = store.get(SETTINGS_KEY);
      if (s) {
        if (s.phase) setPhase(s.phase);
        if (s.magnitude) setMagnitude(s.magnitude);
        if (s.tdeeWindow) setTdeeWindow(s.tdeeWindow);
      }
      const p = store.get(PROFILE_KEY);
      if (p) setProfile({ ...DEFAULT_PROFILE, ...p });
      const c = store.get(CYCLE_KEY);
      if (c) setCycle(c);
      const g = store.get(GOAL_KEY);
      if (g) setGoal(g);
      const ph = store.get(PHASEHIST_KEY);
      if (ph) setPhaseHist(ph);
      const t = store.get(THEME_KEY);
      if (t === "light" || t === "dark") setTheme(t);
    } catch (_) {}
    setLoaded(true);
  }, []);

  // Inject theme stylesheet once + keep data-theme in sync
  useEffect(() => {
    let styleEl = document.getElementById("bt-theme-style");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "bt-theme-style";
      styleEl.textContent = THEME_CSS;
      document.head.appendChild(styleEl);
    }
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.background = "var(--bg)";
    if (document.body) document.body.style.background = "var(--bg)";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0f1117" : "#f4f5f7");
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    store.set(THEME_KEY, next);
  };

  const persist = (nextEntries) => {
    if (store.set(STORAGE_KEY, nextEntries)) {
      setSaveStatus("Saved");
      setTimeout(() => setSaveStatus(""), 1500);
    } else {
      setSaveStatus("Save failed");
    }
  };

  const persistSettings = (p, m, w = tdeeWindow) => {
    store.set(SETTINGS_KEY, { phase: p, magnitude: m, tdeeWindow: w });
  };

  const saveProfile = (next) => {
    setProfile(next);
    store.set(PROFILE_KEY, next);
  };

  const saveCycle = (next) => {
    setCycle(next);
    store.set(CYCLE_KEY, next);
  };

  const saveGoal = (next) => {
    setGoal(next);
    store.set(GOAL_KEY, next);
  };

  const savePhaseHist = (next) => {
    setPhaseHist(next);
    store.set(PHASEHIST_KEY, next);
  };

  const setPhaseAndMag = (p, m) => {
    const changed = p !== phase || m !== magnitude;
    setPhase(p);
    setMagnitude(m);
    persistSettings(p, m);
    // New phase/intensity → start a fresh review cycle anchored today
    const nt = calcTarget(measuredTDEE ?? calcBaselineTDEE(profile, macroWeight), p, m);
    if (nt != null) saveCycle({ anchorDate: today, lockedTarget: nt, syncedPhaseDate: today });
    // Append to phase history (replace same-day record so toggling doesn't spam)
    if (changed) {
      const w = latestWeight;
      const filtered = phaseHist.filter(h => h.date !== today);
      savePhaseHist([...filtered, { date: today, phase: p, magnitude: m, weightKg: w ?? null }]);
    }
  };

  // Save a partial set of fields into the active date (merge, never overwrite siblings)
  // Outlier check: compare a new weight against the most recent prior reading.
  // Flags implausible day-to-day jumps (>2.5% BW or >2.5kg, whichever is smaller-magnitude
  // trigger) as likely water/sodium/measurement noise rather than real fat/muscle change.
  const checkWeightOutlier = (newWeight) => {
    const priorDates = sorted.filter(d => d !== activeDate && entries[d]?.weight != null);
    if (priorDates.length === 0) return null;
    const priorDate = priorDates[priorDates.length - 1];
    const priorWeight = Number(entries[priorDate].weight);
    const daysApart = Math.max(1, Math.abs((new Date(activeDate + "T00:00:00") - new Date(priorDate + "T00:00:00")) / 86400000));
    const diff = newWeight - priorWeight;
    const pctChange = Math.abs(diff) / priorWeight;
    // Scale tolerance by days apart (a jump over many days is less suspicious per-day)
    const threshold = Math.max(0.025, 0.012 * daysApart); // 2.5% minimum, loosens ~1.2%/day gap
    if (pctChange > threshold && Math.abs(diff) > 1.0) {
      return { priorDate, priorWeight, diff, daysApart };
    }
    return null;
  };

  const saveFields = async (fields) => {
    const clean = {};
    Object.entries(fields).forEach(([k, v]) => { if (v !== "" && v != null) clean[k] = Number(v); });
    if (!Object.keys(clean).length) return false;
    const next = { ...entries, [activeDate]: { ...(entries[activeDate] || {}), ...clean } };
    setEntries(next);
    await persist(next);
    return true;
  };

  const handleSaveMorning = async () => {
    if (morningForm.weight !== "") {
      const outlier = checkWeightOutlier(Number(morningForm.weight));
      if (outlier) {
        const sign = outlier.diff > 0 ? "+" : "";
        setDialog({
          title: "Unusual weight jump",
          message: `${sign}${outlier.diff.toFixed(1)} kg vs ${outlier.priorWeight.toFixed(1)} kg on ${outlier.priorDate} (${outlier.daysApart}d ago). This is a bigger swing than typical day-to-day change — likely water, sodium, or a digit slip rather than real fat/muscle change. Save it anyway?`,
          actions: [
            { label: "Save anyway", style: "primary", onClick: async () => { setDialog(null); const ok = await saveFields({ weight: morningForm.weight, bf: morningForm.bf }); if (ok) setMorningForm({ weight: "", bf: "" }); } },
            { label: "Let me fix it", style: "ghost", onClick: () => setDialog(null) },
          ],
        });
        return;
      }
    }
    const ok = await saveFields({ weight: morningForm.weight, bf: morningForm.bf });
    if (ok) setMorningForm({ weight: "", bf: "" });
  };

  const handleSaveEvening = async () => {
    const ok = await saveFields({ calories: eveningForm.calories, protein: eveningForm.protein });
    if (ok) setEveningForm({ calories: "", protein: "" });
  };

  const handleDelete = async (date) => {
    const next = { ...entries };
    delete next[date];
    setEntries(next);
    await persist(next);
  };

  // Load a past date into both cards for editing
  const handleEdit = (date) => {
    const e = entries[date] || {};
    setActiveDate(date);
    setMorningForm({ weight: e.weight ?? "", bf: e.bf ?? "" });
    setEveningForm({ calories: e.calories ?? "", protein: e.protein ?? "" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const resetToToday = () => {
    setActiveDate(today);
    setMorningForm({ weight: "", bf: "" });
    setEveningForm({ calories: "", protein: "" });
  };

  // Step the active day by ±1 (never past today). Reuses handleEdit to load that day.
  const shiftDay = (delta) => {
    const d = new Date(activeDate + "T00:00:00");
    d.setDate(d.getDate() + delta);
    const next = formatDate(d);
    if (next > today) return; // no future
    handleEdit(next);
  };

  const openDatePicker = () => {
    const el = dateInputRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") { try { el.showPicker(); return; } catch (_) {} }
    el.focus(); el.click();
  };

  const sorted = Object.keys(entries).sort();
  const last7 = sorted.slice(-7).map(d => ({ date: d, ...parseEntry(entries[d]) }));

  // Gap detection: days since the most recent logged entry
  const GAP_THRESHOLD = 7;
  const lastEntryDate = sorted.length ? sorted[sorted.length - 1] : null;
  const daysSinceLastEntry = lastEntryDate
    ? Math.floor((new Date(today + "T00:00:00") - new Date(lastEntryDate + "T00:00:00")) / 86400000)
    : null;
  const returningFromGap = daysSinceLastEntry != null && daysSinceLastEntry >= GAP_THRESHOLD;

  // Missing-yesterday nudge: short gap, not a full "welcome back" — just a quick reminder.
  const yesterdayStr = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return formatDate(d); })();
  const yesterdayMissing = !returningFromGap && sorted.length > 0 && !entries[yesterdayStr] && yesterdayStr !== today;

  const avgCals = avg(last7.map(e => e.calories).filter(v => v != null));
  const avgWeight = avg(last7.map(e => e.weight).filter(v => v != null));
  const avgBf = avg(last7.map(e => e.bf).filter(v => v != null));

  // Dated series for regression-based TDEE
  const datedAll = sorted.map(d => ({ date: d, ts: new Date(d + "T00:00:00").getTime(), ...parseEntry(entries[d]) }));
  const tdee14 = calcTDEEWindow(datedAll, 14);
  const tdee28 = calcTDEEWindow(datedAll, 28);
  const tdeeResult = tdeeWindow === 28 ? tdee28 : tdee14;
  const tdee = tdeeResult?.tdee ?? null;

  // Confidence: compare 14d vs 28d when both exist
  let tdeeConfidence = null; // 'high' | 'low' | null
  if (tdee14 && tdee28) {
    tdeeConfidence = Math.abs(tdee14.tdee - tdee28.tdee) <= 300 ? "high" : "low";
  }

  // Bodyweight: most recent logged weight, else 7-day average
  const latestWeight = (() => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const w = entries[sorted[i]]?.weight;
      if (w != null) return Number(w);
    }
    return null;
  })();
  const macroWeight = latestWeight ?? avgWeight;

  // Effective TDEE: use measured (regression) when reliable, else Mifflin-St Jeor baseline
  const measuredTDEE = tdee;
  const baselineTDEE = calcBaselineTDEE(profile, macroWeight);
  const effectiveTDEE = measuredTDEE ?? baselineTDEE;
  const tdeeSource = measuredTDEE != null ? "measured" : (baselineTDEE != null ? "baseline" : null);

  const formulaTarget = calcTarget(effectiveTDEE, phase, magnitude);

  // Phase history sorted oldest→newest. Declared here (before the review-cycle block
  // and the historical-target helpers below) because both consume it.
  const sortedPhaseHist = [...(phaseHist || [])].sort((a, b) => a.date.localeCompare(b.date));

  // ── Locked 2-week review cycle ──
  // cycle.anchorDate is the window start. cycle.syncedPhaseDate records which phase-history
  // date the anchor was last synced to. If the most recent phase-history date changes
  // (including being edited earlier or later via Stats → Phase History) and no manual
  // review action has happened since, the anchor follows that corrected date automatically.
  const latestPhaseChangeDate = sortedPhaseHist.length ? sortedPhaseHist[sortedPhaseHist.length - 1].date : null;
  const phaseAnchorDrifted = latestPhaseChangeDate != null && cycle?.syncedPhaseDate !== undefined && cycle.syncedPhaseDate !== latestPhaseChangeDate;
  const effectiveAnchorDate = phaseAnchorDrifted ? latestPhaseChangeDate : (cycle?.anchorDate ?? latestPhaseChangeDate);
  const daysSinceAnchor = effectiveAnchorDate
    ? Math.floor((new Date(today + "T00:00:00") - new Date(effectiveAnchorDate + "T00:00:00")) / 86400000)
    : null;
  const reviewDue = cycle != null && daysSinceAnchor != null && daysSinceAnchor >= REVIEW_DAYS;

  // LOCKED TARGET LOGIC:
  // - If an active cycle exists: ALWAYS use locked target (never let TDEE changes override)
  // - Review is just a proposal — doesn't affect daily target until Apply is clicked
  // - If no cycle: use formula target
  // The ONLY ways to change target are: (1) change phase/magnitude, or (2) click Apply on review
  const target = (cycle && cycle.lockedTarget != null) ? cycle.lockedTarget : formulaTarget;

  // Compute the review proposal when due
  let review = null;
  if (reviewDue && cycle && effectiveTDEE != null && phase !== "maintain") {
    // actual weight rate over the cycle window (kg/week) via regression
    const winStart = new Date(effectiveAnchorDate + "T00:00:00").getTime();
    const wPts = datedAll.filter(d => d.weight != null && d.ts >= winStart).map(d => ({ x: d.ts, y: d.weight }));
    const reg = wPts.length >= 4 ? linReg(wPts) : null;
    const actualPerWeek = reg ? reg.slope * 7 * 86400000 : null;
    // goal rate (kg/week) from phase % of bodyweight (midpoint of the band)
    const goalPerWeek = goalRatePerWeek(phase, magnitude, macroWeight);
    if (actualPerWeek != null && goalPerWeek != null) {
      const offBy = actualPerWeek - goalPerWeek; // +ve = losing too slow (cut) / gaining too fast (bulk)
      // Decide direction of calorie change
      let delta = 0;
      const tol = 0.1; // kg/week tolerance — within this, hold
      if (phase === "cut") {
        // want negative goal; if actual loss slower than goal (actual > goal), cut calories
        if (actualPerWeek > goalPerWeek + tol) delta = -ADJUST_STEP;
        else if (actualPerWeek < goalPerWeek - tol) delta = +ADJUST_STEP;
      } else { // bulk
        if (actualPerWeek < goalPerWeek - tol) delta = +ADJUST_STEP;
        else if (actualPerWeek > goalPerWeek + tol) delta = -ADJUST_STEP;
      }
      // Review uses the SAME target variable as daily display — single source of truth
      // This ensures consistency: both show the same "current" value
      review = {
        actualPerWeek, goalPerWeek, offBy, delta,
        current: target,
        proposed: target + delta,
        onTrack: delta === 0,
        weighIns: wPts.length,
      };
    }
  }

  const macros = calcMacros(target, macroWeight, phase, magnitude);

  // ── Goal projection ──
  let goalInfo = null;
  if (goal?.weightKg && latestWeight != null) {
    const remaining = goal.weightKg - latestWeight; // +ve = need to gain
    // current rate (kg/week): prefer 28d regression, else 14d, else cycle window
    const ratePts = datedAll.filter(d => d.weight != null);
    let ratePerWeek = null;
    if (ratePts.length >= 4) {
      const recent = ratePts.filter(d => d.ts >= Date.now() - 28 * 86400000);
      const reg = (recent.length >= 4 ? linReg(recent.map(d => ({ x: d.ts, y: d.weight })))
                                       : linReg(ratePts.map(d => ({ x: d.ts, y: d.weight }))));
      if (reg) ratePerWeek = reg.slope * 7 * 86400000;
    }
    const daysToDate = goal.date ? Math.ceil((new Date(goal.date + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000) : null;
    const requiredRate = daysToDate && daysToDate > 0 ? remaining / (daysToDate / 7) : null; // kg/week needed
    let weeksToGoal = null, projDate = null, onPace = null;
    if (ratePerWeek != null && Math.abs(ratePerWeek) > 0.01 && Math.sign(ratePerWeek) === Math.sign(remaining) && Math.abs(remaining) > 0.05) {
      weeksToGoal = remaining / ratePerWeek;
      projDate = new Date(Date.now() + weeksToGoal * 7 * 86400000);
    }
    if (requiredRate != null && ratePerWeek != null) {
      // on pace if current rate meets/exceeds required (same direction & magnitude)
      onPace = Math.sign(ratePerWeek) === Math.sign(requiredRate) && Math.abs(ratePerWeek) >= Math.abs(requiredRate) * 0.9;
    }
    goalInfo = { remaining, ratePerWeek, daysToDate, requiredRate, weeksToGoal, projDate, onPace, atGoal: Math.abs(remaining) <= 0.3 };
  }

  // ── Adherence / consistency ──
  const adherence = (() => {
    if (sorted.length === 0) return null;
    const firstDate = new Date(sorted[0] + "T00:00:00");
    const spanDays = Math.max(1, Math.floor((new Date(today + "T00:00:00") - firstDate) / 86400000) + 1);
    const calDays = sorted.filter(d => entries[d].calories != null).length;
    const wtDays = sorted.filter(d => entries[d].weight != null).length;
    // current streak: consecutive days up to today with any entry
    let streak = 0;
    for (let i = 0; ; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = formatDate(d);
      if (entries[key]) streak++;
      else if (i === 0) continue; // today not logged yet — don't break streak
      else break;
    }
    // last 7 / 28 day coverage
    const cov = (days) => {
      const cutoff = Date.now() - days * 86400000;
      let logged = 0;
      for (let i = 0; i < days; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        if (entries[formatDate(d)]) logged++;
      }
      return Math.round((logged / days) * 100);
    };
    return {
      spanDays, calDays, wtDays,
      calPct: Math.round((calDays / spanDays) * 100),
      wtPct: Math.round((wtDays / spanDays) * 100),
      streak, cov7: cov(7), cov28: cov(28),
      totalLogged: sorted.length,
    };
  })();

  const displayRows = [...sorted].reverse().slice(0, 30);

  // ── Historical target per log row, based on the phase active on that date ──
  // (so "vs Target" reflects what your target was at the time, not today's target).
  const phaseOnDate = (dateStr) => {
    let active = sortedPhaseHist.length ? sortedPhaseHist[0] : { phase, magnitude };
    for (const h of sortedPhaseHist) {
      if (h.date <= dateStr) active = h; else break;
    }
    return { phase: active.phase, magnitude: active.magnitude };
  };
  const historicalTargetCache = {};
  const targetForDate = (dateStr) => {
    if (historicalTargetCache[dateStr] !== undefined) return historicalTargetCache[dateStr];
    const { phase: pOnDate, magnitude: mOnDate } = phaseOnDate(dateStr);
    const asOfTs = new Date(dateStr + "T23:59:59").getTime();
    // TDEE as it would have been measured using only data up to this date
    const histTdeeResult = calcTDEEWindow(datedAll, 14, asOfTs) || calcTDEEWindow(datedAll, 28, asOfTs);
    let histTdee = histTdeeResult?.tdee ?? null;
    if (histTdee == null) {
      // Fall back to baseline using the nearest known weight up to that date
      let nearestWeight = null;
      for (let i = datedAll.length - 1; i >= 0; i--) {
        if (datedAll[i].ts <= asOfTs && datedAll[i].weight != null) { nearestWeight = datedAll[i].weight; break; }
      }
      histTdee = calcBaselineTDEE(profile, nearestWeight ?? macroWeight);
    }
    const t = calcTarget(histTdee, pOnDate, mOnDate);
    historicalTargetCache[dateStr] = t;
    return t;
  };

  // ── Report: resolved date range ──
  const reportEnd = reportRange === "custom" ? (reportCustomEnd || today) : today;
  const reportStart = reportRange === "custom"
    ? (reportCustomStart || addDaysStr(reportEnd, -29))
    : addDaysStr(today, -(REPORT_RANGES[reportRange].days - 1));

  // ── Report: build a full data + insights bundle for [start, end] ──
  function buildReport(startDate, endDate) {
    const rangeDates = sorted.filter(d => d >= startDate && d <= endDate);
    const rangeEntries = rangeDates.map(d => ({ date: d, ...parseEntry(entries[d]) }));
    const spanDays = Math.max(1, Math.round((new Date(endDate + "T00:00:00") - new Date(startDate + "T00:00:00")) / 86400000) + 1);

    const calRows = rangeEntries.filter(e => e.calories != null);
    const wRows = rangeEntries.filter(e => e.weight != null);
    const bfRows = rangeEntries.filter(e => e.bf != null);
    const pRows = rangeEntries.filter(e => e.protein != null);

    const avgCalories = avg(calRows.map(e => e.calories));
    const avgProtein = avg(pRows.map(e => e.protein));

    // Weight/BF trend via regression within range
    const wPts = wRows.map(e => ({ x: new Date(e.date + "T00:00:00").getTime(), y: e.weight }));
    const bfPts = bfRows.map(e => ({ x: new Date(e.date + "T00:00:00").getTime(), y: e.bf }));
    const wReg = wPts.length >= 2 ? linReg(wPts) : null;
    const bfReg = bfPts.length >= 2 ? linReg(bfPts) : null;
    const weightChange = wReg ? wReg.slope * (wPts[wPts.length - 1].x - wPts[0].x) / 86400000 : null;
    const weightChangePerWeek = wReg ? wReg.slope * 7 * 86400000 : null;
    const bfChange = bfReg ? bfReg.slope * (bfPts[bfPts.length - 1].x - bfPts[0].x) / 86400000 : null;
    const startWeight = wRows.length ? wRows[0].weight : null;
    const endWeight = wRows.length ? wRows[wRows.length - 1].weight : null;
    const startBf = bfRows.length ? bfRows[0].bf : null;
    const endBf = bfRows.length ? bfRows[bfRows.length - 1].bf : null;

    // Adherence to historical target within range
    let onTargetDays = 0, overDays = 0, underDays = 0, targetComparable = 0;
    calRows.forEach(e => {
      const t = targetForDate(e.date);
      const pOnDate = phaseOnDate(e.date).phase;
      if (t == null) return;
      targetComparable++;
      const diff = e.calories - t;
      const good = pOnDate === "cut" ? diff <= 100 : pOnDate === "bulk" ? diff >= -100 : Math.abs(diff) <= 100;
      if (good) onTargetDays++;
      else if (diff > 0) overDays++;
      else underDays++;
    });

    // Protein-hit rate within range
    let proteinHitDays = 0;
    pRows.forEach(e => {
      const m = calcMacros(targetForDate(e.date), endWeight ?? macroWeight, phaseOnDate(e.date).phase, phaseOnDate(e.date).magnitude);
      if (m && e.protein >= m.proteinG * 0.9) proteinHitDays++;
    });

    // Phase history overlapping the range
    const phasesInRange = sortedPhaseHist.filter((h, i) => {
      const nextDate = sortedPhaseHist[i + 1]?.date ?? "9999-99-99";
      return h.date <= endDate && nextDate > startDate;
    });

    // TDEE snapshot (current, for context — not recalculated per range to keep it simple/clear)
    const tdeeSnapshot = effectiveTDEE;
    const tdeeSourceSnapshot = tdeeSource;

    // ── Auto-generated insights & recommendations ──
    const insights = [];
    const calLogPct = Math.round((calRows.length / spanDays) * 100);
    const wLogPct = Math.round((wRows.length / spanDays) * 100);
    if (calLogPct < 50) insights.push({ type: "warn", text: `Calories were only logged ${calLogPct}% of days in this period — adherence stats below are based on limited data.` });
    if (targetComparable >= 4) {
      const overPct = Math.round((overDays / targetComparable) * 100);
      const underPct = Math.round((underDays / targetComparable) * 100);
      if (phase === "cut" && overPct >= 40) insights.push({ type: "warn", text: `You were over your cut target on ${overPct}% of logged days — this likely explains a slower-than-planned rate of loss.` });
      if (phase === "bulk" && underPct >= 40) insights.push({ type: "warn", text: `You were under your bulk target on ${underPct}% of logged days — this likely explains slower-than-planned gain.` });
      if (onTargetDays / targetComparable >= 0.8) insights.push({ type: "good", text: `Strong adherence — within range of target on ${Math.round((onTargetDays / targetComparable) * 100)}% of logged days.` });
    }
    if (pRows.length >= 4) {
      const hitPct = Math.round((proteinHitDays / pRows.length) * 100);
      if (hitPct < 60) insights.push({ type: "warn", text: `Protein target was hit on only ${hitPct}% of logged days — consider an easier protein source at a meal you often skip it.` });
      else insights.push({ type: "good", text: `Protein target hit on ${hitPct}% of logged days.` });
    }
    if (weightChangePerWeek != null && phase !== "maintain") {
      const goalWk = goalRatePerWeek(phase, magnitude, endWeight ?? macroWeight);
      if (goalWk != null) {
        const ratio = goalWk !== 0 ? weightChangePerWeek / goalWk : null;
        if (ratio != null && ratio < 0.5) insights.push({ type: "warn", text: `Actual rate (${weightChangePerWeek.toFixed(2)} kg/wk) is well below the ${phase} target pace (${goalWk.toFixed(2)} kg/wk) for this period.` });
        else if (ratio != null && ratio > 1.6) insights.push({ type: "warn", text: `Rate of change (${weightChangePerWeek.toFixed(2)} kg/wk) is running faster than the planned pace — watch for excess muscle loss (cut) or fat gain (bulk).` });
      }
    }
    if (goalInfo && !goalInfo.atGoal && goalInfo.onPace != null) {
      insights.push({ type: goalInfo.onPace ? "good" : "warn", text: goalInfo.onPace ? "Currently on pace to reach your goal weight by the target date." : "Currently behind pace to reach your goal weight by the target date." });
    }
    if (dietBreak?.due) insights.push({ type: "warn", text: `You've been cutting continuously for ~${Math.round(dietBreak.weeks)} weeks — a planned maintenance week is recommended.` });
    if (insights.length === 0) insights.push({ type: "neutral", text: "Nothing notable to flag for this period — keep logging consistently to sharpen future insights." });

    return {
      startDate, endDate, spanDays,
      calLogPct, wLogPct,
      avgCalories, avgProtein,
      startWeight, endWeight, weightChange, weightChangePerWeek,
      startBf, endBf, bfChange,
      onTargetDays, overDays, underDays, targetComparable,
      proteinHitDays, proteinTracked: pRows.length,
      phasesInRange,
      tdeeSnapshot, tdeeSourceSnapshot,
      goalSnapshot: goalInfo,
      insights,
      entryCount: rangeDates.length,
    };
  }

  // ── Weekly summary: last 7 days vs prior 7 ──
  const weekly = (() => {
    if (sorted.length < 3) return null;
    const now = Date.now();
    const inWindow = (d, startDaysAgo, endDaysAgo) => {
      const t = new Date(d + "T00:00:00").getTime();
      return t >= now - startDaysAgo * 86400000 && t < now - endDaysAgo * 86400000;
    };
    const thisWk = sorted.filter(d => inWindow(d, 7, 0));
    const prevWk = sorted.filter(d => inWindow(d, 14, 7));
    if (thisWk.length === 0) return null;

    const calsThis = thisWk.map(d => entries[d].calories).filter(v => v != null);
    const calsPrev = prevWk.map(d => entries[d].calories).filter(v => v != null);
    const avgCalThis = avg(calsThis);
    const avgCalPrev = avg(calsPrev);

    // weight change over the last 7d via regression (robust to noise)
    const wPtsThis = thisWk.filter(d => entries[d].weight != null).map(d => ({ x: new Date(d + "T00:00:00").getTime(), y: entries[d].weight }));
    let wkWeightChange = null;
    if (wPtsThis.length >= 2) {
      const reg = linReg(wPtsThis);
      if (reg) wkWeightChange = reg.slope * 7 * 86400000; // kg over 7d
    }

    const proteinDays = thisWk.filter(d => entries[d].protein != null);
    const proteinHit = (target != null && macros) ? proteinDays.filter(d => entries[d].protein >= macros.proteinG * 0.9).length : null;

    const calLogged = calsThis.length;
    const wtLogged = thisWk.filter(d => entries[d].weight != null).length;

    return {
      avgCalThis, avgCalPrev,
      calDelta: (avgCalThis != null && avgCalPrev != null) ? avgCalThis - avgCalPrev : null,
      wkWeightChange,
      calLogged, wtLogged,
      proteinTracked: proteinDays.length,
      proteinHit,
      proteinTarget: macros?.proteinG ?? null,
    };
  })();

  // ── Diet-break / refeed awareness ──
  // Cumulative continuous days in a cut, from the most recent phase-history run.
  const dietBreak = (() => {
    if (phase !== "cut") return null;
    const hist = [...phaseHist].sort((a, b) => a.date.localeCompare(b.date));
    // find the start of the current uninterrupted cut run
    let runStart = today;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].phase === "cut") runStart = hist[i].date;
      else break;
    }
    const days = Math.floor((new Date(today + "T00:00:00") - new Date(runStart + "T00:00:00")) / 86400000);
    const weeks = days / 7;
    // Suggest a maintenance break at ≥6 weeks of continuous cutting
    return { days, weeks, due: weeks >= 6, runStart };
  })();

  const reportData = buildReport(reportStart, reportEnd);

  // Auto-start a cycle once we have a real target and none is running
  useEffect(() => {
    if (!loaded) return;
    if (cycle == null && formulaTarget != null) {
      saveCycle({ anchorDate: today, lockedTarget: formulaTarget, syncedPhaseDate: latestPhaseChangeDate ?? today });
    }
  }, [loaded, cycle, formulaTarget]);

  // Seed phase history with the current phase if empty
  useEffect(() => {
    if (!loaded) return;
    if (phaseHist.length === 0) {
      savePhaseHist([{ date: today, phase, magnitude, weightKg: latestWeight ?? null }]);
    }
  }, [loaded]);

  // Returning after a gap: re-anchor the review cycle to today so the next review
  // measures a clean fresh window rather than a stretched, patchy one. Runs once on load.
  const gapHandledRef = useRef(false);
  useEffect(() => {
    if (!loaded || gapHandledRef.current) return;
    gapHandledRef.current = true;
    if (returningFromGap && cycle?.anchorDate && lastEntryDate && cycle.anchorDate <= lastEntryDate) {
      // keep the locked target, just restart the 2-week clock from today; phase sync unchanged
      saveCycle({ anchorDate: today, lockedTarget: cycle.lockedTarget, syncedPhaseDate: cycle.syncedPhaseDate });
    }
  }, [loaded]);

  const acceptReview = () => {
    // First click: show confirmation dialog
    if (!reviewConfirming) {
      setReviewConfirming(true);
      return;
    }
    // Second click: confirm and save (double-click protection)
    if (!review || !cycle) return;
    
    // Save new cycle with updated locked target
    // CRITICAL: syncedPhaseDate must equal latestPhaseChangeDate exactly
    // If it doesn't match, phaseAnchorDrifted=true and effectiveAnchorDate
    // recalculates from the original phase change date (14+ days ago),
    // keeping reviewDue=true and the review box permanently visible
    const newCycle = {
      anchorDate: today,
      lockedTarget: review.proposed,
      syncedPhaseDate: latestPhaseChangeDate ?? cycle.syncedPhaseDate
    };
    saveCycle(newCycle);
    setReviewConfirming(false);
    showToast(review.delta === 0 ? "Cycle reset — holding target" : `Target → ${review.proposed.toLocaleString()} kcal`);
  };
  const cancelReviewConfirm = () => {
    setReviewConfirming(false);
  };
  const holdReview = () => {
    if (!cycle) return;
    saveCycle({ anchorDate: today, lockedTarget: target, syncedPhaseDate: latestPhaseChangeDate ?? cycle.syncedPhaseDate });
    showToast("Holding current target");
  };

  const activeEntry = entries[activeDate] || {};
  const isToday = activeDate === today;
  const morningLogged = activeEntry.weight != null || activeEntry.bf != null;
  const eveningLogged = activeEntry.calories != null;

  const phaseInfo = PHASES[phase];
  const rec = recommendPhase(avgBf);
  const magInfo = phaseInfo?.magnitudes.find(m => m.id === magnitude);
  const badge = deltaBadge(avgCals, target, phase);
  const rateLabel = weeklyRateLabel(phase, magnitude, avgWeight);

  // 7-day protein: average over logged days, the daily goal, and hit rate (days ≥90% of goal)
  const avgProtein = avg(last7.map(e => e.protein).filter(v => v != null));
  const proteinGoal = macros?.proteinG ?? null;
  const proteinTracked7 = last7.filter(e => e.protein != null);
  const proteinHits7 = proteinGoal != null ? proteinTracked7.filter(e => e.protein >= proteinGoal * 0.9).length : 0;
  const proteinHitColor = proteinTracked7.length > 0 && (proteinHits7 / proteinTracked7.length) >= 0.8 ? "#34d399" : "#fbbf24";

  // ── Chart data for Trends view ──
  const rangeDays = RANGES[range].days;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rangeDays);
  const cutoffStr = formatDate(cutoff);

  const chartData = sorted
    .filter(d => d >= cutoffStr)
    .map(d => {
      const e = parseEntry(entries[d]);
      return {
        date: d,
        ts: new Date(d + "T00:00:00").getTime(),
        weight: e.weight,
        bf: e.bf,
      };
    });

  const isOverlayMode = metric === "overlay";
  const metricRows = isOverlayMode ? [] : chartData.filter(r => r[metric] != null);
  const reg = isOverlayMode ? null : linReg(metricRows.map(r => ({ x: r.ts, y: r[metric] })));
  let trendStart = null, trendEnd = null, totalChange = null, weeklyChange = null;
  if (reg && metricRows.length >= 2) {
    const firstTs = metricRows[0].ts;
    const lastTs = metricRows[metricRows.length - 1].ts;
    trendStart = reg.slope * firstTs + reg.intercept;
    trendEnd = reg.slope * lastTs + reg.intercept;
    totalChange = trendEnd - trendStart;
    weeklyChange = reg.slope * 7 * 86400000;
  }
  // attach trend line value to each point
  const chartWithTrend = metricRows.map(r => ({
    ...r,
    trend: reg ? reg.slope * r.ts + reg.intercept : null,
  }));

  const metricCfg = isOverlayMode ? null : {
    weight: { label: "Weight", unit: "kg", color: "#8b5cf6", decimals: 1 },
    bf: { label: "Body Fat", unit: "%", color: "#a78bfa", decimals: 1 },
  }[metric];

  // ── Combined weight+BF overlay data (dual axis) — shows recomposition at a glance ──
  const overlayData = chartData.filter(r => r.weight != null || r.bf != null);

  // ── Phase-change markers within the visible range, for chart annotation ──
  const phaseMarkers = (phaseHist || [])
    .filter(h => h.date >= cutoffStr)
    .map(h => ({ date: h.date, ts: new Date(h.date + "T00:00:00").getTime(), phase: h.phase, magnitude: h.magnitude }));

  // ── Export helpers ──
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 2200); };

  const buildCSV = () => {
    const header = "date,calories,weight_kg,body_fat_pct,protein_g";
    const rows = sorted.map(d => {
      const e = parseEntry(entries[d]);
      return [d, e.calories ?? "", e.weight ?? "", e.bf ?? "", e.protein ?? ""].join(",");
    });
    return [header, ...rows].join("\n");
  };

  const buildJSON = () => JSON.stringify(
    { exported: new Date().toISOString(), phase, magnitude, tdeeWindow, profile, cycle, goal, phaseHist, entries },
    null, 2
  );

  const downloadFile = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const stamp = today;

  // ── Report: Markdown builder ──
  const buildReportMarkdown = (r) => {
    const fmt1 = (v) => v != null ? v.toFixed(1) : "—";
    const fmt2 = (v) => v != null ? v.toFixed(2) : "—";
    const lines = [];
    lines.push(`# Body Tracker Report`);
    lines.push(`**${r.startDate} → ${r.endDate}** (${r.spanDays} days)`);
    lines.push("");
    lines.push(`## Overview`);
    lines.push(`- Entries logged: ${r.entryCount} (${r.calLogPct}% of days for calories, ${r.wLogPct}% for weight)`);
    lines.push(`- Weight: ${fmt1(r.startWeight)} kg → ${fmt1(r.endWeight)} kg (${r.weightChange != null ? (r.weightChange >= 0 ? "+" : "") + fmt2(r.weightChange) + " kg total, " + (r.weightChangePerWeek >= 0 ? "+" : "") + fmt2(r.weightChangePerWeek) + " kg/wk" : "insufficient data"})`);
    lines.push(`- Body fat: ${fmt1(r.startBf)}% → ${fmt1(r.endBf)}% (${r.bfChange != null ? (r.bfChange >= 0 ? "+" : "") + fmt2(r.bfChange) + " pts total" : "insufficient data"})`);
    lines.push(`- Average calories: ${r.avgCalories != null ? Math.round(r.avgCalories).toLocaleString() : "—"} kcal/day`);
    lines.push(`- Average protein: ${r.avgProtein != null ? Math.round(r.avgProtein) + " g/day" : "not tracked"}`);
    lines.push(`- TDEE at time of report: ${r.tdeeSnapshot != null ? r.tdeeSnapshot.toLocaleString() + " kcal (" + r.tdeeSourceSnapshot + ")" : "—"}`);
    lines.push("");
    lines.push(`## Adherence`);
    if (r.targetComparable > 0) {
      lines.push(`- On/near target: ${r.onTargetDays}/${r.targetComparable} days (${Math.round((r.onTargetDays / r.targetComparable) * 100)}%)`);
      lines.push(`- Over target: ${r.overDays} days · Under target: ${r.underDays} days`);
    } else {
      lines.push(`- Not enough logged data with a known target to assess.`);
    }
    if (r.proteinTracked > 0) {
      lines.push(`- Protein target hit: ${r.proteinHitDays}/${r.proteinTracked} tracked days (${Math.round((r.proteinHitDays / r.proteinTracked) * 100)}%)`);
    }
    lines.push("");
    if (r.phasesInRange.length) {
      lines.push(`## Phases in this period`);
      r.phasesInRange.forEach(h => lines.push(`- ${h.date}: ${PHASE_META_LABEL(h.phase)}${h.magnitude ? " · " + (MAG_LABEL[h.magnitude] || h.magnitude) : ""}`));
      lines.push("");
    }
    if (r.goalSnapshot && !r.goalSnapshot.atGoal) {
      lines.push(`## Goal`);
      lines.push(`- ${fmt1(r.goalSnapshot.remaining != null ? Math.abs(r.goalSnapshot.remaining) : null)} kg ${r.goalSnapshot.remaining > 0 ? "to gain" : "to lose"}, current pace ${fmt2(r.goalSnapshot.ratePerWeek)} kg/wk, ${r.goalSnapshot.onPace ? "on pace" : "behind pace"}.`);
      lines.push("");
    }
    lines.push(`## Insights & Recommendations`);
    r.insights.forEach(i => lines.push(`- ${i.type === "good" ? "✅" : i.type === "warn" ? "⚠️" : "ℹ️"} ${i.text}`));
    lines.push("");
    lines.push(`_Generated ${new Date().toLocaleString()} by Body Tracker._`);
    return lines.join("\n");
  };

  const exportReportMD = (r) => {
    downloadFile(buildReportMarkdown(r), `body-tracker-report-${r.startDate}-to-${r.endDate}.md`, "text/markdown");
    showToast("Report markdown downloaded");
  };

  const copyReportMD = async (r) => {
    try { await navigator.clipboard.writeText(buildReportMarkdown(r)); showToast("Report copied — paste anywhere"); }
    catch (_) { showToast("Copy failed"); }
  };

  // PDF export: render a clean printable document in a new window and trigger the browser's
  // native print dialog (choose "Save as PDF"). Avoids adding a PDF-generation dependency.
  const exportReportPDF = (r) => {
    const fmt1 = (v) => v != null ? v.toFixed(1) : "—";
    const fmt2 = (v) => v != null ? v.toFixed(2) : "—";
    const win = window.open("", "_blank");
    if (!win) { showToast("Pop-up blocked — allow pop-ups to export PDF"); return; }
    const rowsHtml = r.insights.map(i =>
      `<li class="${i.type}">${i.type === "good" ? "✅" : i.type === "warn" ? "⚠️" : "ℹ️"} ${i.text}</li>`
    ).join("");
    const phasesHtml = r.phasesInRange.length
      ? `<h2>Phases in this period</h2><ul>${r.phasesInRange.map(h => `<li>${h.date}: ${PHASE_META_LABEL(h.phase)}${h.magnitude ? " · " + (MAG_LABEL[h.magnitude] || h.magnitude) : ""}</li>`).join("")}</ul>`
      : "";
    const goalHtml = (r.goalSnapshot && !r.goalSnapshot.atGoal)
      ? `<h2>Goal</h2><p>${fmt1(Math.abs(r.goalSnapshot.remaining))} kg ${r.goalSnapshot.remaining > 0 ? "to gain" : "to lose"}, current pace ${fmt2(r.goalSnapshot.ratePerWeek)} kg/wk — <strong>${r.goalSnapshot.onPace ? "on pace" : "behind pace"}</strong>.</p>`
      : "";
    win.document.write(`<!doctype html><html><head><title>Body Tracker Report ${r.startDate} to ${r.endDate}</title>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, system-ui, sans-serif; color: #1f2937; max-width: 680px; margin: 32px auto; padding: 0 20px; line-height: 1.5; }
        h1 { font-size: 22px; margin-bottom: 2px; }
        h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin-top: 28px; }
        .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        td { padding: 5px 0; }
        td.label { color: #6b7280; width: 45%; }
        td.value { font-weight: 600; text-align: right; }
        ul { padding-left: 18px; font-size: 13px; }
        li.warn { color: #b45309; }
        li.good { color: #047857; }
        .footer { margin-top: 36px; font-size: 11px; color: #9ca3af; }
        @media print { body { margin: 0; } }
      </style></head><body>
      <h1>Body Tracker Report</h1>
      <div class="sub">${r.startDate} → ${r.endDate} (${r.spanDays} days)</div>

      <h2>Overview</h2>
      <table>
        <tr><td class="label">Entries logged</td><td class="value">${r.entryCount} (${r.calLogPct}% calories, ${r.wLogPct}% weight)</td></tr>
        <tr><td class="label">Weight</td><td class="value">${fmt1(r.startWeight)} → ${fmt1(r.endWeight)} kg ${r.weightChangePerWeek != null ? `(${r.weightChangePerWeek >= 0 ? "+" : ""}${fmt2(r.weightChangePerWeek)} kg/wk)` : ""}</td></tr>
        <tr><td class="label">Body fat</td><td class="value">${fmt1(r.startBf)}% → ${fmt1(r.endBf)}%</td></tr>
        <tr><td class="label">Average calories</td><td class="value">${r.avgCalories != null ? Math.round(r.avgCalories).toLocaleString() + " kcal/day" : "—"}</td></tr>
        <tr><td class="label">Average protein</td><td class="value">${r.avgProtein != null ? Math.round(r.avgProtein) + " g/day" : "not tracked"}</td></tr>
        <tr><td class="label">TDEE</td><td class="value">${r.tdeeSnapshot != null ? r.tdeeSnapshot.toLocaleString() + " kcal (" + r.tdeeSourceSnapshot + ")" : "—"}</td></tr>
      </table>

      <h2>Adherence</h2>
      <table>
        <tr><td class="label">On/near target</td><td class="value">${r.targetComparable > 0 ? `${r.onTargetDays}/${r.targetComparable} days (${Math.round((r.onTargetDays / r.targetComparable) * 100)}%)` : "—"}</td></tr>
        <tr><td class="label">Protein target hit</td><td class="value">${r.proteinTracked > 0 ? `${r.proteinHitDays}/${r.proteinTracked} days (${Math.round((r.proteinHitDays / r.proteinTracked) * 100)}%)` : "not tracked"}</td></tr>
      </table>

      ${phasesHtml}
      ${goalHtml}

      <h2>Insights & Recommendations</h2>
      <ul>${rowsHtml}</ul>

      <div class="footer">Generated ${new Date().toLocaleString()} by Body Tracker.</div>
      <script>window.onload = () => setTimeout(() => window.print(), 200);</script>
      </body></html>`);
    win.document.close();
    showToast("Opening print dialog — choose 'Save as PDF'");
  };

  const exportCSV = () => {
    if (!sorted.length) { showToast("No data to export"); return; }
    downloadFile(buildCSV(), `body-tracker-${stamp}.csv`, "text/csv");
    showToast("CSV downloaded");
    setMenuOpen(false);
  };

  const exportJSON = () => {
    if (!sorted.length) { showToast("No data to export"); return; }
    downloadFile(buildJSON(), `body-tracker-${stamp}.json`, "application/json");
    showToast("JSON downloaded");
    setMenuOpen(false);
  };

  const copyCSV = async () => {
    if (!sorted.length) { showToast("No data to export"); return; }
    try {
      await navigator.clipboard.writeText(buildCSV());
      showToast("Copied — paste into Sheets");
    } catch (_) { showToast("Copy failed"); }
    setMenuOpen(false);
  };

  const openDrive = () => {
    // Drive can't receive a file directly from an artifact (needs OAuth on a real host).
    // Best path here: download the CSV, then open Drive to upload it.
    exportCSV();
    window.open("https://drive.google.com/drive/my-drive", "_blank", "noopener");
    showToast("CSV saved — drop it into Drive");
    setMenuOpen(false);
  };

  // ── Import ──
  const triggerImport = () => {
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  // Parse a CSV in the same shape we export: date,calories,weight_kg,body_fat_pct,protein_g
  const parseCSV = (text) => {
    const lines = text.trim().split(/\r?\n/);
    const out = {};
    const header = lines[0]?.toLowerCase() ?? "";
    const start = header.includes("date") ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const date = (cols[0] || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const rec = {};
      const cal = parseFloat(cols[1]); if (!isNaN(cal)) rec.calories = cal;
      const wt = parseFloat(cols[2]); if (!isNaN(wt)) rec.weight = wt;
      const bf = parseFloat(cols[3]); if (!isNaN(bf)) rec.bf = bf;
      const pr = parseFloat(cols[4]); if (!isNaN(pr)) rec.protein = pr;
      if (Object.keys(rec).length) out[date] = rec;
    }
    return out;
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so the same file can be re-picked later
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (_) { showToast("Couldn't read file"); return; }

    let imported = null, settings = null;
    if (file.name.toLowerCase().endsWith(".json")) {
      try {
        const parsed = JSON.parse(text);
        imported = parsed.entries ?? parsed; // accept {entries,...} or bare map
        if (parsed.phase || parsed.magnitude || parsed.tdeeWindow || parsed.profile || parsed.cycle || parsed.goal || parsed.phaseHist) settings = parsed;
      } catch (_) { showToast("Invalid JSON file"); return; }
    } else {
      imported = parseCSV(text);
    }

    if (!imported || typeof imported !== "object" || !Object.keys(imported).length) {
      showToast("No valid entries found"); return;
    }

    const incomingCount = Object.keys(imported).length;
    const existingCount = Object.keys(entries).length;

    const applyImport = (merged) => {
      setEntries(merged);
      persist(merged);
      if (settings) {
        if (settings.phase) setPhase(settings.phase);
        if (settings.magnitude) setMagnitude(settings.magnitude);
        if (settings.tdeeWindow) setTdeeWindow(settings.tdeeWindow);
        persistSettings(settings.phase ?? phase, settings.magnitude ?? magnitude, settings.tdeeWindow ?? tdeeWindow);
        if (settings.profile) saveProfile({ ...DEFAULT_PROFILE, ...settings.profile });
        if (settings.cycle) saveCycle(settings.cycle);
        if (settings.goal !== undefined) saveGoal(settings.goal);
        if (settings.phaseHist) savePhaseHist(settings.phaseHist);
      }
      showToast(`Imported ${incomingCount} entries`);
    };

    if (existingCount === 0) {
      applyImport(imported);
      return;
    }

    setDialog({
      title: "Import data",
      message: `This file has ${incomingCount} entries. You already have ${existingCount}. How should they combine?`,
      actions: [
        { label: "Merge", style: "primary", onClick: () => { setDialog(null); applyImport({ ...entries, ...imported }); } },
        { label: "Replace all", style: "danger", onClick: () => { setDialog(null); applyImport(imported); } },
        { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
      ],
    });
  };


  if (!loaded) return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: 14 }}>Loading…</span>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "'Inter', 'SF Pro Display', system-ui, sans-serif", paddingBottom: 60 }}>

      {/* Header */}
      <div style={{ borderBottom: "1px solid var(--border)", padding: "20px 24px 18px", display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "#6366f1" }}>BODY</span>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--text)" }}>TRACKER</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          {saveStatus && (
            <span style={{ fontSize: 11, color: saveStatus === "Saved" ? "#34d399" : "#f87171", letterSpacing: "0.05em" }}>
              {saveStatus === "Saved" ? "✓ SAVED" : "⚠ SAVE FAILED"}
            </span>
          )}
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            aria-label="Toggle theme"
            style={{ background: "transparent", border: "none", borderRadius: 6, width: 32, height: 32, cursor: "pointer", color: "var(--text-soft)", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          {/* Profile button */}
          <button
            onClick={() => setProfileOpen(true)}
            aria-label="Profile"
            style={{ background: "transparent", border: "none", borderRadius: 6, width: 32, height: 32, cursor: "pointer", color: "var(--text-soft)", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            ⚙
          </button>
          {/* 3-dot menu */}
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              aria-label="Menu"
              style={{ background: menuOpen ? "var(--border)" : "transparent", border: "none", borderRadius: 6, width: 32, height: 32, cursor: "pointer", color: "var(--text-soft)", fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              ⋮
            </button>
            {menuOpen && (
              <>
                {/* click-away backdrop */}
                <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div style={{ position: "absolute", right: 0, top: 38, zIndex: 50, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 6, minWidth: 220, boxShadow: "0 12px 32px var(--shadow)" }}>
                  <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, padding: "8px 10px 6px" }}>Export {sorted.length ? `· ${sorted.length} entries` : ""}</div>
                  {[
                    { label: "Save to Google Drive", sub: "Downloads CSV, opens Drive", onClick: openDrive, accent: "#34d399" },
                    { label: "Download CSV", sub: "Spreadsheet format", onClick: exportCSV },
                    { label: "Download JSON", sub: "Full backup incl. settings", onClick: exportJSON },
                    { label: "Copy to clipboard", sub: "Paste into Sheets/Excel", onClick: copyCSV },
                  ].map((item) => (
                    <button key={item.label} onClick={item.onClick}
                      style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", borderRadius: 6, padding: "9px 10px", cursor: "pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background = "var(--border)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: item.accent || "var(--text)" }}>{item.label}</div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>{item.sub}</div>
                    </button>
                  ))}

                  <div style={{ borderTop: "1px solid var(--border)", margin: "6px 4px", paddingTop: 6 }}>
                    <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, padding: "2px 6px 6px" }}>Restore</div>
                    <button onClick={triggerImport}
                      style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", borderRadius: 6, padding: "9px 10px", cursor: "pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background = "var(--border)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#60a5fa" }}>Import from file</div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>Restore a JSON or CSV backup</div>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Hidden import file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.csv,application/json,text/csv"
        onChange={handleImportFile}
        style={{ display: "none" }}
      />

      {/* Profile modal */}
      {profileOpen && (
        <ProfileModal
          profile={profile}
          age={ageFromDOB(profile.dob)}
          baselineTDEE={baselineTDEE}
          onSave={(p) => { saveProfile(p); setProfileOpen(false); showToast("Profile saved"); }}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {/* Goal modal */}
      {goalOpen && (
        <GoalModal
          goal={goal}
          latestWeight={latestWeight}
          latestBf={avgBf}
          onSave={(g) => { saveGoal(g); setGoalOpen(false); showToast("Goal saved"); }}
          onClear={() => { saveGoal(null); setGoalOpen(false); showToast("Goal cleared"); }}
          onClose={() => setGoalOpen(false)}
        />
      )}

      {/* Styled confirm dialog */}
      {dialog && <ConfirmDialog {...dialog} onClose={() => setDialog(null)} />}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 100, background: "var(--border)", border: "1px solid var(--border-strong)", color: "var(--text)", fontSize: 12, fontWeight: 600, padding: "10px 18px", borderRadius: 999, boxShadow: "0 8px 24px var(--shadow)", letterSpacing: "0.02em" }}>
          {toast}
        </div>
      )}

      {/* Tab switcher */}
      <div style={{ borderBottom: "1px solid var(--border)", display: "flex", gap: 4, padding: "0 16px", maxWidth: 820, margin: "0 auto" }}>
        {[
          { id: "log", label: "Log & Targets" },
          { id: "macros", label: "Macros" },
          { id: "trends", label: "Trends" },
          { id: "stats", label: "Stats" },
          { id: "report", label: "Report" },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "14px 14px 12px", fontSize: 12, fontWeight: 600,
              letterSpacing: "0.04em", color: view === t.id ? "var(--text)" : "var(--text-dim)",
              borderBottom: `2px solid ${view === t.id ? "#6366f1" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 16px" }}>
        {view === "trends" && (
          <TrendsView
            range={range} setRange={setRange}
            metric={metric} setMetric={setMetric}
            chartWithTrend={chartWithTrend} metricRows={metricRows}
            metricCfg={metricCfg} totalChange={totalChange} weeklyChange={weeklyChange}
            theme={theme} overlayData={overlayData} phaseMarkers={phaseMarkers}
          />
        )}
        {view === "macros" && (
          <MacrosView
            macros={macros} target={target} tdee={effectiveTDEE}
            phase={phase} phaseInfo={phaseInfo} magInfo={magInfo} magnitude={magnitude}
            macroWeight={macroWeight} sortedLen={sorted.length}
            avgBf={avgBf} profile={profile}
          />
        )}
        {view === "stats" && (
          <StatsView
            adherence={adherence} phaseHist={phaseHist}
            weekly={weekly} goalInfo={goalInfo} phase={phase}
            onDeletePhase={(date) => setDialog({
              title: "Delete phase record?",
              message: `Remove the phase change logged on ${date}? This only affects the history log, not your entries.`,
              actions: [
                { label: "Delete", style: "danger", onClick: () => { setDialog(null); savePhaseHist(phaseHist.filter(h => h.date !== date)); showToast("Phase record removed"); } },
                { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
              ],
            })}
            onEditPhaseDate={(oldDate, newDate) => {
              if (newDate === oldDate) return;
              if (phaseHist.some(h => h.date === newDate)) {
                showToast("Another phase already starts that day");
                return;
              }
              const isLatest = oldDate === latestPhaseChangeDate;
              const next = phaseHist.map(h => h.date === oldDate ? { ...h, date: newDate } : h);
              savePhaseHist(next);
              showToast(isLatest ? `Phase start moved to ${newDate} — review cycle synced` : `Phase start moved to ${newDate}`);
            }}
          />
        )}
        {view === "report" && (
          <ReportView
            reportRange={reportRange} setReportRange={setReportRange}
            reportCustomStart={reportCustomStart} setReportCustomStart={setReportCustomStart}
            reportCustomEnd={reportCustomEnd} setReportCustomEnd={setReportCustomEnd}
            reportData={reportData}
            onExportMD={() => exportReportMD(reportData)}
            onCopyMD={() => copyReportMD(reportData)}
            onExportPDF={() => exportReportPDF(reportData)}
          />
        )}
        {view === "log" && (
        <>

        {/* ── Welcome-back banner after a gap ── */}
        {returningFromGap && (
          <div style={{ marginTop: 28, marginBottom: 4, background: "var(--surface)", border: "1px solid #34d39955", borderLeft: "3px solid #34d399", borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#34d399", marginBottom: 6 }}>Welcome back</div>
            <div style={{ fontSize: 11, color: "var(--text-soft)", lineHeight: 1.55 }}>
              It's been {daysSinceLastEntry} days since your last entry. Your history is safe — but the rolling averages, measured TDEE, and goal pace lean on recent data, so they'll look thin until you've logged a few days again. Your review cycle has been reset to start fresh from today. Just pick up logging where you left off.
            </div>
          </div>
        )}

        {/* ── Missing-yesterday nudge ── */}
        {yesterdayMissing && (
          <div style={{ marginTop: 28, marginBottom: 4, background: "var(--surface)", border: "1px solid #fbbf2455", borderLeft: "3px solid #fbbf24", borderRadius: 8, padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
              No entry logged for <strong style={{ color: "var(--text)" }}>{yesterdayStr}</strong>.
            </div>
            <button onClick={() => handleEdit(yesterdayStr)}
              style={{ background: "transparent", border: "1px solid #fbbf24", color: "#fbbf24", borderRadius: 6, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
              Log it now
            </button>
          </div>
        )}

        {/* ── Entry: split morning / evening cards ── */}
        <div style={{ marginTop: 24, marginBottom: 28 }}>
          {/* Date bar — arrow stepper + tappable label that opens the calendar */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button onClick={() => shiftDay(-1)} aria-label="Previous day"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, width: 34, height: 34, cursor: "pointer", color: "var(--text-soft)", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                ‹
              </button>
              <button onClick={openDatePicker}
                style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "0 14px", height: 34, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, minWidth: 150, justifyContent: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                  {isToday ? "Today" : new Date(activeDate + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>▾</span>
              </button>
              <button onClick={() => shiftDay(1)} disabled={isToday} aria-label="Next day"
                style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, width: 34, height: 34, cursor: isToday ? "default" : "pointer", color: isToday ? "var(--text-faint)" : "var(--text-soft)", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", opacity: isToday ? 0.5 : 1 }}>
                ›
              </button>
              {/* hidden native date input, opened by the label */}
              <input
                ref={dateInputRef}
                type="date"
                value={activeDate}
                max={today}
                onChange={e => { if (e.target.value) handleEdit(e.target.value); }}
                style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
                tabIndex={-1}
              />
            </div>
            {!isToday && (
              <button onClick={resetToToday}
                style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                Back to today
              </button>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* Morning card */}
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 16px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <span style={{ fontSize: 14 }}>🌅</span>
                <span style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-bright)", fontWeight: 700 }}>Morning</span>
                {morningLogged && (
                  <span style={{ marginLeft: "auto", fontSize: 9, color: "#34d399", fontWeight: 700, letterSpacing: "0.06em" }}>✓ LOGGED</span>
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 12, lineHeight: 1.4 }}>Fasted weight &amp; body fat</div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Weight (kg)</label>
                <input type="number" inputMode="decimal" value={morningForm.weight}
                  placeholder={morningLogged && activeEntry.weight != null ? String(activeEntry.weight) : "e.g. 84.1"}
                  onChange={e => setMorningForm(f => ({ ...f, weight: e.target.value }))}
                  style={inputStyle} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Body Fat (%)</label>
                <input type="number" inputMode="decimal" value={morningForm.bf}
                  placeholder={morningLogged && activeEntry.bf != null ? String(activeEntry.bf) : "e.g. 18.5"}
                  onChange={e => setMorningForm(f => ({ ...f, bf: e.target.value }))}
                  style={inputStyle} />
              </div>
              <button onClick={handleSaveMorning}
                disabled={morningForm.weight === "" && morningForm.bf === ""}
                style={{
                  width: "100%", background: (morningForm.weight === "" && morningForm.bf === "") ? "var(--border)" : "#8b5cf6",
                  color: (morningForm.weight === "" && morningForm.bf === "") ? "var(--text-dim)" : "#fff",
                  border: "none", borderRadius: 6, padding: "9px", fontSize: 12, fontWeight: 600,
                  letterSpacing: "0.04em", textTransform: "uppercase",
                  cursor: (morningForm.weight === "" && morningForm.bf === "") ? "default" : "pointer",
                }}>
                {morningLogged ? "Update Morning" : "Save Morning"}
              </button>
            </div>

            {/* Evening card */}
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 16px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <span style={{ fontSize: 14 }}>🌙</span>
                <span style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-bright)", fontWeight: 700 }}>Evening</span>
                {eveningLogged && (
                  <span style={{ marginLeft: "auto", fontSize: 9, color: "#34d399", fontWeight: 700, letterSpacing: "0.06em" }}>✓ LOGGED</span>
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 12, lineHeight: 1.4 }}>Final daily totals</div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Calories (kcal)</label>
                <input type="number" inputMode="numeric" value={eveningForm.calories}
                  placeholder={eveningLogged ? String(activeEntry.calories) : "e.g. 2100"}
                  onChange={e => setEveningForm(f => ({ ...f, calories: e.target.value }))}
                  style={inputStyle} />
              </div>
              {target != null && eveningForm.calories !== "" && (
                <div style={{ fontSize: 10, marginBottom: 12, color: "var(--text-muted)" }}>
                  Target {target.toLocaleString()} · {(() => {
                    const d = Math.round(Number(eveningForm.calories) - target);
                    const c = phase === "cut" ? (d > 0 ? "#f87171" : "#34d399") : phase === "bulk" ? (d > 0 ? "#34d399" : "#f87171") : (Math.abs(d) <= 100 ? "#34d399" : "#f87171");
                    return <span style={{ color: c, fontWeight: 600 }}>{d > 0 ? "+" : ""}{d} kcal</span>;
                  })()}
                </div>
              )}
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Protein (g){macros ? ` · target ${macros.proteinG}` : ""}</label>
                <input type="number" inputMode="numeric" value={eveningForm.protein}
                  placeholder={activeEntry.protein != null ? String(activeEntry.protein) : (macros ? `e.g. ${macros.proteinG}` : "e.g. 180")}
                  onChange={e => setEveningForm(f => ({ ...f, protein: e.target.value }))}
                  style={inputStyle} />
                {macros && eveningForm.protein !== "" && (
                  <div style={{ fontSize: 10, marginTop: 6 }}>
                    {(() => {
                      const p = Number(eveningForm.protein);
                      const hit = p >= macros.proteinG * 0.9;
                      const d = Math.round(p - macros.proteinG);
                      return <span style={{ color: hit ? "#34d399" : "var(--text-muted)", fontWeight: 600 }}>
                        {hit ? "✓ target hit" : `${d} g short of target`}
                      </span>;
                    })()}
                  </div>
                )}
              </div>
              <button onClick={handleSaveEvening}
                disabled={eveningForm.calories === "" && eveningForm.protein === ""}
                style={{
                  width: "100%", background: (eveningForm.calories === "" && eveningForm.protein === "") ? "var(--border)" : "#6366f1",
                  color: (eveningForm.calories === "" && eveningForm.protein === "") ? "var(--text-dim)" : "#fff",
                  border: "none", borderRadius: 6, padding: "9px", fontSize: 12, fontWeight: 600,
                  letterSpacing: "0.04em", textTransform: "uppercase",
                  cursor: (eveningForm.calories === "" && eveningForm.protein === "") ? "default" : "pointer",
                }}>
                {eveningLogged ? "Update Evening" : "Save Evening"}
              </button>
            </div>
          </div>
        </div>

        {/* ── Review prompt (2-week cycle due) ── */}
        {review && (
          <div style={{ marginTop: 28, marginBottom: 4, background: "var(--surface)", border: "1px solid #fbbf2455", borderLeft: "3px solid #fbbf24", borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#fbbf24", marginBottom: 8 }}>2-week review ready</div>
            <div style={{ fontSize: 11, color: "var(--text-soft)", lineHeight: 1.55, marginBottom: 10 }}>
              Over the last {REVIEW_DAYS} days your weight moved {review.actualPerWeek >= 0 ? "+" : ""}{review.actualPerWeek.toFixed(2)} kg/wk
              {" "}(goal {review.goalPerWeek >= 0 ? "+" : ""}{review.goalPerWeek.toFixed(2)} kg/wk, from {review.weighIns} weigh-ins).{" "}
              {review.onTrack
                ? "You're on track — no change needed."
                : `Suggest ${review.delta > 0 ? "adding" : "cutting"} ${Math.abs(review.delta)} kcal: ${review.current.toLocaleString()} → ${review.proposed.toLocaleString()} kcal/day.`}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {!review.onTrack && (
                <>
                  <button onClick={acceptReview}
                    style={{ background: reviewConfirming ? "#dc2626" : "#fbbf24", color: reviewConfirming ? "#fff" : "var(--surface)", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 11, fontWeight: 700, letterSpacing: "0.03em", cursor: "pointer", transition: "all 150ms" }}>
                    {reviewConfirming ? "Confirm — lock in?" : `Apply ${review.proposed.toLocaleString()}`}
                  </button>
                  {reviewConfirming && (
                    <button onClick={cancelReviewConfirm}
                      style={{ background: "transparent", color: "var(--text-soft)", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                      Cancel
                    </button>
                  )}
                </>
              )}
              <button onClick={review.onTrack ? acceptReview : holdReview}
                style={{ background: review.onTrack ? "#34d399" : "transparent", color: review.onTrack ? "var(--bg)" : "var(--text-soft)", border: review.onTrack ? "none" : "1px solid var(--border-strong)", borderRadius: 6, padding: "7px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                {review.onTrack ? "Start next cycle" : "Hold current"}
              </button>
            </div>
          </div>
        )}

        {/* ── Diet-break suggestion (long cut) ── */}
        {dietBreak?.due && (
          <div style={{ marginTop: 28, marginBottom: 4, background: "var(--surface)", border: "1px solid #60a5fa55", borderLeft: "3px solid #60a5fa", borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#60a5fa", marginBottom: 8 }}>Consider a diet break</div>
            <div style={{ fontSize: 11, color: "var(--text-soft)", lineHeight: 1.55, marginBottom: 10 }}>
              You've been cutting for about {Math.round(dietBreak.weeks)} weeks straight. The evidence (Helms; the MATADOR study) supports a planned <strong style={{ color: "var(--text)" }}>maintenance week</strong> every 6–8 weeks of continuous deficit — it helps restore hormones (leptin, thyroid), reduces fatigue, and improves long-term adherence and muscle retention. Eating at maintenance for ~7 days won't undo your progress.
            </div>
            <button onClick={() => setPhaseAndMag("maintain", "maintain")}
              style={{ background: "#60a5fa", color: "#06121f", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 11, fontWeight: 700, letterSpacing: "0.03em", cursor: "pointer" }}>
              Switch to maintenance
            </button>
          </div>
        )}

        {/* ── Recommendation ── */}
        <div style={{ marginTop: 28, marginBottom: 20, background: "var(--surface)", border: `1px solid ${rec.tone}40`, borderLeft: `3px solid ${rec.tone}`, borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: rec.tone, letterSpacing: "0.01em" }}>{rec.headline}</div>
            {rec.phase && (rec.phase !== phase || rec.magnitude !== magnitude) && (
              <button
                onClick={() => setPhaseAndMag(rec.phase, rec.magnitude)}
                style={{ background: "transparent", border: `1px solid ${rec.tone}`, color: rec.tone, borderRadius: 6, padding: "5px 12px", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", cursor: "pointer" }}
              >
                Apply
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-soft)", lineHeight: 1.55, marginTop: 7 }}>{rec.body}</div>
          {avgBf != null && (
            <div style={{ fontSize: 9, color: "var(--border-strong)", marginTop: 8, letterSpacing: "0.02em" }}>
              Based on your 7-day BF average. Thresholds for an intermediate male lifter (bulk ≤12%, cut ≥18%, flexible 13–17%). Add ~8–10% for female ranges.
            </div>
          )}
        </div>

        {/* ── Phase Selector ── */}
        <div style={{ marginTop: 28, marginBottom: 20 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Phase</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
            {Object.entries(PHASES).map(([key, info]) => {
              const active = phase === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    const defaultMag = key === "maintain" ? "maintain" : key === "cut" ? "moderate" : "moderate";
                    setPhaseAndMag(key, defaultMag);
                  }}
                  style={{
                    background: active ? info.color + "1a" : "var(--surface)",
                    border: `1px solid ${active ? info.color : "var(--border)"}`,
                    borderRadius: 8, padding: "12px 10px", cursor: "pointer",
                    textAlign: "center", transition: "all 0.15s",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: active ? info.color : "var(--text-muted)", letterSpacing: "0.04em" }}>{info.label}</div>
                </button>
              );
            })}
          </div>

          {/* Magnitude selector — hidden for maintain */}
          {phase !== "maintain" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {phaseInfo.magnitudes.map(mag => {
                const active = magnitude === mag.id;
                return (
                  <button
                    key={mag.id}
                    onClick={() => setPhaseAndMag(phase, mag.id)}
                    style={{
                      background: active ? phaseInfo.color + "1a" : "transparent",
                      border: `1px solid ${active ? phaseInfo.color : "var(--border)"}`,
                      borderRadius: 6, padding: "8px 8px 7px", cursor: "pointer",
                      textAlign: "center", transition: "all 0.15s",
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 600, color: active ? phaseInfo.color : "var(--text-muted)" }}>{mag.label}</div>
                    <div style={{ fontSize: 9, color: active ? "var(--text-soft)" : "var(--border-strong)", marginTop: 2, letterSpacing: "0.03em" }}>{mag.sublabel}</div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Rationale pill */}
          {magInfo && (
            <div style={{ marginTop: 10, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "9px 12px" }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.5 }}>{magInfo.description}</span>
            </div>
          )}
        </div>

        {/* ── Stats Row ── */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>7-Day Averages</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              {
                label: "Calories", value: avgCals != null ? Math.round(avgCals).toLocaleString() : "—", unit: "kcal", accent: "#6366f1",
                sub: target != null ? (
                  <span>goal {target.toLocaleString()}{badge ? <span style={{ color: badge.color, fontWeight: 600 }}> · {badge.label.replace(" vs target", "")}</span> : null}</span>
                ) : null,
              },
              {
                label: "Protein", value: avgProtein != null ? Math.round(avgProtein).toLocaleString() : "—", unit: "g", accent: "#f472b6",
                sub: proteinGoal != null ? (
                  <span>goal {proteinGoal} g{proteinTracked7.length > 0 ? <span style={{ color: proteinHitColor, fontWeight: 600 }}> · {proteinHits7}/{proteinTracked7.length} ≥90%</span> : null}</span>
                ) : null,
              },
              { label: "Weight", value: avgWeight != null ? avgWeight.toFixed(1) : "—", unit: "kg", accent: "#8b5cf6" },
              { label: "Body Fat", value: avgBf != null ? avgBf.toFixed(1) : "—", unit: "%", accent: "#a78bfa" },
            ].map(({ label, value, unit, accent, sub }) => (
              <div key={label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 14px 12px" }}>
                <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 8 }}>{label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <span style={{ fontSize: 20, fontWeight: 700, color: accent, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{value}</span>
                  {value !== "—" && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{unit}</span>}
                </div>
                {sub && value !== "—" && (
                  <div style={{ fontSize: 9.5, color: "var(--text-dim)", marginTop: 5, fontVariantNumeric: "tabular-nums" }}>{sub}</div>
                )}
              </div>
            ))}
          </div>

          {/* TDEE card with window toggle */}
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600 }}>TDEE Estimate</span>
                {tdeeConfidence && (
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", color: tdeeConfidence === "high" ? "#34d399" : "#fbbf24" }}>
                    {tdeeConfidence === "high" ? "● STABLE" : "● NOISY"}
                  </span>
                )}
              </div>
              {/* window toggle */}
              <div style={{ display: "flex", gap: 4 }}>
                {[14, 28].map(w => (
                  <button key={w} onClick={() => { setTdeeWindow(w); persistSettings(phase, magnitude, w); }}
                    style={{
                      background: tdeeWindow === w ? "var(--surface-2)" : "transparent",
                      border: `1px solid ${tdeeWindow === w ? "#34d399" : "var(--border)"}`,
                      borderRadius: 5, padding: "4px 10px", cursor: "pointer",
                      fontSize: 10, fontWeight: 600, color: tdeeWindow === w ? "#34d399" : "var(--text-muted)",
                    }}>
                    {w}d
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: "#34d399", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
                {tdee != null ? tdee.toLocaleString() : "—"}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>kcal/day</span>
              {tdeeResult && (
                <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 6 }}>
                  from {tdeeResult.days}d · {tdeeResult.calorieDays} logged · {tdeeResult.weightPoints} weigh-ins
                </span>
              )}
            </div>
            {tdee14 && tdee28 && (
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
                14-day: {tdee14.tdee.toLocaleString()} · 28-day: {tdee28.tdee.toLocaleString()} kcal
                {tdeeConfidence === "low" && <span style={{ color: "#fbbf24" }}> — windows disagree by &gt;300 kcal; keep logging before trusting the target.</span>}
              </div>
            )}
          </div>

          {/* Target calorie card */}
          {target != null && (
            <div style={{
              background: phaseInfo.color + "1a",
              border: `1px solid ${phaseInfo.color}40`,
              borderRadius: 8, padding: "14px 16px",
              display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10,
              opacity: tdeeConfidence === "low" ? 0.7 : 1,
            }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: phaseInfo.color + "99", fontWeight: 600, marginBottom: 6 }}>
                  {phaseInfo.label}{phase !== "maintain" ? ` · ${magInfo?.label}` : ""} — Daily Target
                </div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 28, fontWeight: 800, color: phaseInfo.color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.03em" }}>
                    {target.toLocaleString()}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>kcal/day</span>
                  {badge && (
                    <span style={{ fontSize: 10, color: badge.color, marginLeft: 8, fontWeight: 600 }}>{badge.label}</span>
                  )}
                </div>
                <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 6, letterSpacing: "0.02em" }}>
                  {tdeeSource === "baseline" && "Baseline estimate (Mifflin-St Jeor) — switches to measured TDEE after ~10 days. "}
                  {cycle && !reviewDue && daysSinceAnchor != null && (
                    <span>🔒 Locked · day {daysSinceAnchor + 1} of {REVIEW_DAYS} — review in {REVIEW_DAYS - daysSinceAnchor} day{REVIEW_DAYS - daysSinceAnchor === 1 ? "" : "s"}.</span>
                  )}
                  {reviewDue && <span style={{ color: "#fbbf24" }}>Review ready — see prompt above.</span>}
                </div>
              </div>
              {rateLabel && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 4 }}>Expected rate</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: phaseInfo.color, fontVariantNumeric: "tabular-nums" }}>{rateLabel}</div>
                </div>
              )}
            </div>
          )}

          {target == null && sorted.length > 0 && (
            <div style={{ background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 8, padding: "14px 16px", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Log a bodyweight to generate a starting target from your profile. It refines into a measured TDEE after ~10 days of data.
            </div>
          )}
          {tdee != null && (
            <div style={{ fontSize: 10, color: "var(--border-strong)", marginTop: 6 }}>
              TDEE from least-squares weight trend over {tdeeResult?.days}d × 7,700 kcal/kg vs. avg intake. Targets rounded to 25 kcal. Method per Helms et al. 2014 / adaptive-TDEE consensus.
            </div>
          )}
        </div>

        {/* ── Goal card ── */}
        <div style={{ marginBottom: 28 }}>
          {goal?.weightKg ? (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 18px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600 }}>Goal</span>
                <button onClick={() => setGoalOpen(true)} style={{ background: "none", border: "none", color: "#6366f1", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Edit</button>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{goal.weightKg.toFixed(1)}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>kg{goal.bfPercent ? ` @ ${goal.bfPercent.toFixed(1)}%` : " target"}</span>
                {goalInfo && !goalInfo.atGoal && (
                  <span style={{ fontSize: 11, color: "var(--text-soft)", marginLeft: 4 }}>
                    {goalInfo.remaining > 0 ? "+" : ""}{goalInfo.remaining.toFixed(1)} kg to go
                  </span>
                )}
                {goal.date && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
                    by {goal.date}{goalInfo?.daysToDate != null ? ` · ${goalInfo.daysToDate}d` : ""}
                  </span>
                )}
              </div>
              {goalInfo?.atGoal && (
                <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: "#34d399" }}>🎯 You're at your goal weight.</div>
              )}
              {goalInfo && !goalInfo.atGoal && (
                <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 5 }}>Current pace</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#8b5cf6", fontVariantNumeric: "tabular-nums" }}>
                      {goalInfo.ratePerWeek != null ? `${goalInfo.ratePerWeek > 0 ? "+" : ""}${goalInfo.ratePerWeek.toFixed(2)} kg/wk` : "—"}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>
                      {goalInfo.projDate ? `Reaches goal ~${formatDate(goalInfo.projDate)}` : "Not trending toward goal"}
                    </div>
                  </div>
                  <div style={{ background: "var(--bg)", borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 5 }}>Needed pace</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: goalInfo.onPace == null ? "var(--text-muted)" : goalInfo.onPace ? "#34d399" : "#fbbf24", fontVariantNumeric: "tabular-nums" }}>
                      {goalInfo.requiredRate != null ? `${goalInfo.requiredRate > 0 ? "+" : ""}${goalInfo.requiredRate.toFixed(2)} kg/wk` : "—"}
                    </div>
                    <div style={{ fontSize: 10, color: goalInfo.onPace == null ? "var(--text-dim)" : goalInfo.onPace ? "#34d399" : "#fbbf24", marginTop: 3 }}>
                      {goalInfo.onPace == null ? (goal.date ? "Log more to assess" : "No target date set")
                        : goalInfo.onPace ? "On pace ✓" : "Behind pace — tighten up"}
                    </div>
                  </div>
                </div>
              )}
              {goalInfo && !goalInfo.atGoal && goalInfo.requiredRate != null && Math.abs(goalInfo.requiredRate) > (macroWeight * 0.01) && (
                <div style={{ marginTop: 10, fontSize: 10, color: "#fbbf24", lineHeight: 1.5 }}>
                  ⚠ The required pace exceeds ~1% bodyweight/week, which is aggressive and hard to do without muscle loss (cut) or excess fat gain (bulk). Consider extending the date.
                </div>
              )}
            </div>
          ) : (
            <button onClick={() => setGoalOpen(true)}
              style={{ width: "100%", background: "transparent", border: "1px dashed var(--border)", borderRadius: 10, padding: "16px", cursor: "pointer", color: "var(--text-muted)", fontSize: 12 }}>
              + Set a goal weight &amp; target date
            </button>
          )}
        </div>


        {/* ── Log Table ── */}
        {displayRows.length > 0 && (
          <div>
            <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Log</div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Date", "Calories", "vs Target", "Weight", "BF%", ""].map((h, i) => (
                      <th key={i} style={{ padding: "10px 12px", textAlign: i === 0 ? "left" : i === 5 ? "right" : "right", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, background: "var(--surface)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((date, idx) => {
                    const e = parseEntry(entries[date]);
                    const isRecent = last7.some(r => r.date === date);
                    const rowTarget = targetForDate(date);
                    const rowPhase = phaseOnDate(date).phase;
                    let calDiff = null, calColor = "var(--text-muted)";
                    if (e.calories != null && rowTarget != null) {
                      calDiff = Math.round(e.calories - rowTarget);
                      const over = calDiff > 0;
                      if (rowPhase === "cut") calColor = over ? "#f87171" : "#34d399";
                      else if (rowPhase === "bulk") calColor = over ? "#34d399" : "#f87171";
                      else calColor = Math.abs(calDiff) <= 100 ? "#34d399" : "#f87171";
                    }
                    return (
                      <tr key={date} style={{ borderBottom: idx < displayRows.length - 1 ? "1px solid var(--surface-2)" : "none", background: activeDate === date && date !== today ? "var(--surface-2)" : "transparent" }}>
                        <td style={{ padding: "10px 12px", color: isRecent ? "var(--text)" : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                          {date}
                          {isRecent && <span style={{ marginLeft: 6, fontSize: 8, color: "#6366f1", letterSpacing: "0.08em", fontWeight: 700 }}>7D</span>}
                        </td>
                        <td style={{ padding: "10px 12px", textAlign: "right", color: e.calories != null ? "var(--text)" : "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                          {e.calories != null ? e.calories.toLocaleString() : "—"}
                        </td>
                        <td style={{ padding: "10px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
                          {calDiff != null
                            ? <span style={{ color: calColor }}>{calDiff > 0 ? "+" : ""}{calDiff}</span>
                            : <span style={{ color: "var(--text-faint)" }}>—</span>}
                        </td>
                        <td style={{ padding: "10px 12px", textAlign: "right", color: e.weight != null ? "var(--text)" : "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                          {e.weight != null ? e.weight.toFixed(1) : "—"}
                        </td>
                        <td style={{ padding: "10px 12px", textAlign: "right", color: e.bf != null ? "var(--text)" : "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                          {e.bf != null ? `${e.bf.toFixed(1)}%` : "—"}
                        </td>
                        <td style={{ padding: "10px 12px", textAlign: "right" }}>
                          <button onClick={() => handleEdit(date)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, marginRight: 6, padding: "2px 5px" }}>Edit</button>
                          <button onClick={() => handleDelete(date)} style={{ background: "none", border: "none", color: "var(--border-strong)", cursor: "pointer", fontSize: 11, padding: "2px 5px" }}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}>
              "vs Target" uses the calorie target that was active on each date, based on your Phase History — not today's target.
            </div>
            {sorted.length > 30 && (
              <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)", textAlign: "right" }}>Showing 30 most recent of {sorted.length} entries.</div>
            )}
          </div>
        )}

        {sorted.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--border-strong)" }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 12, letterSpacing: "0.05em" }}>No entries yet. Log your first day above.</div>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}

function TrendsView({ range, setRange, metric, setMetric, chartWithTrend, metricRows, metricCfg, totalChange, weeklyChange, theme, overlayData, phaseMarkers }) {
  // Recharts renders SVG attributes that don't resolve CSS var(), so use literal colors.
  const c = theme === "light"
    ? { grid: "#e2e6ec", axis: "#cbd2dc", tick: "#6b7280", trend: "#9aa3b0", panel: "#ffffff", border: "#e2e6ec", tipBg: "#ffffff", tipText: "#4b5563", marker: "#94a3b8" }
    : { grid: "#1f2937", axis: "#374151", tick: "#6b7280", trend: "#4b5563", panel: "#161b27", border: "#1f2937", tipBg: "#0f1117", tipText: "#9ca3af", marker: "#52525b" };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const isOverlay = metric === "overlay";
  const dec = isOverlay ? 1 : metricCfg.decimals;
  const changeColor = totalChange == null ? "var(--text-muted)" : totalChange < 0 ? "#34d399" : "#f87171";
  const PHASE_COLOR = { cut: "#f87171", bulk: "#60a5fa", maintain: "#34d399" };

  return (
    <div style={{ marginTop: 24 }}>
      {/* Metric toggle */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[
          { id: "weight", label: "Weight", color: "#8b5cf6" },
          { id: "bf", label: "Body Fat %", color: "#a78bfa" },
          { id: "overlay", label: "Overlay", color: "#34d399" },
        ].map(m => {
          const active = metric === m.id;
          return (
            <button key={m.id} onClick={() => setMetric(m.id)}
              style={{
                flex: 1, background: active ? "var(--surface)" : "transparent",
                border: `1px solid ${active ? m.color : "var(--border)"}`, borderRadius: 8,
                padding: "10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
                color: active ? m.color : "var(--text-muted)",
              }}>
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Range selector */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 20 }}>
        {Object.entries(RANGES).map(([key, info]) => {
          const active = range === key;
          return (
            <button key={key} onClick={() => setRange(key)}
              style={{
                background: active ? "var(--surface-2)" : "transparent",
                border: `1px solid ${active ? "#6366f1" : "var(--border)"}`, borderRadius: 6,
                padding: "8px", cursor: "pointer", fontSize: 11, fontWeight: 600,
                color: active ? "#a5b4fc" : "var(--text-muted)", letterSpacing: "0.04em",
              }}>
              {info.label}
            </button>
          );
        })}
      </div>

      {/* Summary stats — single-metric only */}
      {!isOverlay && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
          {[
            { label: "Current", value: metricRows.length ? metricRows[metricRows.length - 1][metric].toFixed(dec) : "—", color: metricCfg.color },
            { label: "Total Change", value: totalChange != null ? `${totalChange > 0 ? "+" : ""}${totalChange.toFixed(dec)}` : "—", color: changeColor },
            { label: "Trend / Week", value: weeklyChange != null ? `${weeklyChange > 0 ? "+" : ""}${weeklyChange.toFixed(2)}` : "—", color: changeColor },
          ].map(s => (
            <div key={s.label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 7 }}>{s.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                <span style={{ fontSize: 19, fontWeight: 700, color: s.color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>{s.value}</span>
                {s.value !== "—" && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{metricCfg.unit}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Overlay legend */}
      {isOverlay && (
        <div style={{ display: "flex", gap: 16, marginBottom: 14, fontSize: 11, color: "var(--text-muted)" }}>
          <span><span style={{ color: "#8b5cf6" }}>●</span> Weight (kg, left axis)</span>
          <span><span style={{ color: "#a78bfa" }}>●</span> Body Fat % (right axis)</span>
          {phaseMarkers.length > 0 && <span><span style={{ color: c.marker }}>┊</span> Phase change</span>}
        </div>
      )}

      {/* Chart */}
      {isOverlay ? (
        overlayData.length >= 2 ? (
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 8px 8px 0" }}>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={overlayData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid stroke={c.grid} strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time"
                  tickFormatter={fmtDate} stroke={c.axis} tick={{ fill: c.tick, fontSize: 10 }} />
                <YAxis yAxisId="weight" domain={["auto", "auto"]} stroke={c.axis} tick={{ fill: "#8b5cf6", fontSize: 10 }}
                  tickFormatter={(v) => v.toFixed(1)} width={40} />
                <YAxis yAxisId="bf" orientation="right" domain={["auto", "auto"]} stroke={c.axis} tick={{ fill: "#a78bfa", fontSize: 10 }}
                  tickFormatter={(v) => v.toFixed(1)} width={40} />
                <Tooltip
                  contentStyle={{ background: c.tipBg, border: `1px solid ${c.border}`, borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: c.tipText }}
                  labelFormatter={(ts) => new Date(ts).toLocaleDateString()}
                  formatter={(val, name) => name === "weight" ? [`${Number(val).toFixed(1)} kg`, "Weight"] : [`${Number(val).toFixed(1)}%`, "Body Fat"]}
                />
                {phaseMarkers.map((p) => (
                  <ReferenceLine key={p.date} x={p.ts} yAxisId="weight" stroke={c.marker} strokeDasharray="3 3"
                    label={{ value: PHASE_META_LABEL(p.phase), position: "insideTopLeft", fill: PHASE_COLOR[p.phase] || c.marker, fontSize: 9, fontWeight: 700 }} />
                ))}
                <Line yAxisId="weight" type="monotone" dataKey="weight" stroke="#8b5cf6" strokeWidth={2}
                  dot={{ r: 2.5, fill: "#8b5cf6" }} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
                <Line yAxisId="bf" type="monotone" dataKey="bf" stroke="#a78bfa" strokeWidth={2} strokeDasharray="4 2"
                  dot={{ r: 2.5, fill: "#a78bfa" }} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 10, color: "var(--border-strong)", padding: "4px 16px 4px", textAlign: "center" }}>
              Weight and body fat on separate axes — watch for weight holding steady while body fat drops (recomposition).
            </div>
          </div>
        ) : (
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "48px 0", textAlign: "center", color: "var(--border-strong)" }}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>📈</div>
            <div style={{ fontSize: 12 }}>Need at least 2 weight or body-fat readings in this range to overlay.</div>
          </div>
        )
      ) : metricRows.length >= 2 ? (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 8px 8px 0" }}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartWithTrend} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid stroke={c.grid} strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} scale="time"
                tickFormatter={fmtDate} stroke={c.axis} tick={{ fill: c.tick, fontSize: 10 }} />
              <YAxis domain={["auto", "auto"]} stroke={c.axis} tick={{ fill: c.tick, fontSize: 10 }}
                tickFormatter={(v) => v.toFixed(dec)} width={44} />
              <Tooltip
                contentStyle={{ background: c.tipBg, border: `1px solid ${c.border}`, borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: c.tipText }}
                labelFormatter={(ts) => new Date(ts).toLocaleDateString()}
                formatter={(val, name) => [`${Number(val).toFixed(dec)} ${metricCfg.unit}`, name === "trend" ? "Trend" : metricCfg.label]}
              />
              {phaseMarkers.map((p) => (
                <ReferenceLine key={p.date} x={p.ts} stroke={c.marker} strokeDasharray="3 3"
                  label={{ value: PHASE_META_LABEL(p.phase), position: "insideTopLeft", fill: PHASE_COLOR[p.phase] || c.marker, fontSize: 9, fontWeight: 700 }} />
              ))}
              <Line type="monotone" dataKey="trend" stroke={c.trend} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey={metric} stroke={metricCfg.color} strokeWidth={2}
                dot={{ r: 2.5, fill: metricCfg.color }} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 10, color: "var(--border-strong)", padding: "4px 16px 4px", textAlign: "center" }}>
            Solid line: daily readings. Dashed line: least-squares trend. {phaseMarkers.length > 0 ? "Vertical markers: phase changes." : ""}
          </div>
        </div>
      ) : (
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "48px 0", textAlign: "center", color: "var(--border-strong)" }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>📈</div>
          <div style={{ fontSize: 12 }}>Need at least 2 {metricCfg.label.toLowerCase()} readings in this range to chart a trend.</div>
        </div>
      )}
    </div>
  );
}

function PHASE_META_LABEL(phase) {
  return phase === "cut" ? "Cut" : phase === "bulk" ? "Bulk" : phase === "maintain" ? "Maint." : phase;
}

function MacroBar({ macros, phaseColor }) {
  const segs = [
    { key: "protein", pct: macros.pctProtein, color: "#f472b6", label: "P" },
    { key: "carbs", pct: macros.pctCarbs, color: "#fbbf24", label: "C" },
    { key: "fat", pct: macros.pctFat, color: "#60a5fa", label: "F" },
  ];
  return (
    <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", border: "1px solid var(--border)" }}>
      {segs.map(s => (
        <div key={s.key} style={{ width: `${s.pct}%`, background: s.color }} title={`${s.label} ${s.pct}%`} />
      ))}
    </div>
  );
}

function MacrosView({ macros, target, tdee, phase, phaseInfo, magInfo, magnitude, macroWeight, sortedLen, avgBf, profile }) {
  const [whatIf, setWhatIf] = useState(null); // null = follow target; number = override kcal
  if (tdee == null || target == null || !macros) {
    return (
      <div style={{ marginTop: 24, background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 10, padding: "40px 24px", textAlign: "center", color: "var(--text-muted)" }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>🍽️</div>
        <div style={{ fontSize: 12, lineHeight: 1.6, maxWidth: 380, margin: "0 auto" }}>
          {sortedLen === 0
            ? "Log your weight and a few days of calories to generate a calorie + macro target."
            : "Macros need a calorie target, which needs a stable TDEE (≥10 days of data) and a logged bodyweight. Keep logging and this will populate."}
        </div>
      </div>
    );
  }

  const activeCals = whatIf ?? target;
  const activeMacros = (whatIf != null && whatIf !== target)
    ? (calcMacros(whatIf, macroWeight, phase, magnitude) || macros)
    : macros;
  // Implied weekly weight change at the active intake: (cals - TDEE)/7700 * 7
  const impliedRate = ((activeCals - tdee) / 7700) * 7; // kg/week
  const m2 = activeMacros;

  const macroCards = [
    { key: "protein", label: "Protein", grams: m2.proteinG, cals: m2.proteinCals, pct: m2.pctProtein, perKg: m2.proteinPerKg, color: "#f472b6", note: `${m2.proteinPerKg.toFixed(1)} g/kg` },
    { key: "carbs", label: "Carbs", grams: m2.carbsG, cals: m2.carbCals, pct: m2.pctCarbs, color: "#fbbf24", note: "fills remaining energy" },
    { key: "fat", label: "Fat", grams: m2.fatG, cals: m2.fatCals, pct: m2.pctFat, perKg: m2.fatPerKg, color: "#60a5fa", note: `${m2.fatPerKg.toFixed(1)} g/kg` },
  ];

  // Slider range. Upper bound unchanged (TDEE + 1000). Lower bound now extends to whichever
  // is lower: the old TDEE − 1000 floor, or 500 kcal below the goal (snapped to the nearest
  // 500 kcal), so the user can explore intakes well under their current target.
  const goalFloor = Math.round((target - 500) / 500) * 500; // 500 below goal, snapped to nearest 500
  const sliderMin = Math.min(Math.round((tdee - 1000) / 25) * 25, goalFloor);
  const sliderMax = Math.round((tdee + 1000) / 25) * 25;
  const isOverridden = whatIf != null && whatIf !== target;

  // ── "Too low?" risk model for the active intake ──────────────────────────────
  // Grounded in: rate-of-loss guidance (Helms 2014; Garthe 2011 ≈ 0.5–1% BW/wk to retain
  // lean mass) and the fat-store energy-flux ceiling (Alpert 2005 ≈ 31 kcal per lb of fat
  // mass per day that body fat can supply before the shortfall is met from lean tissue).
  const FAT_KCAL_PER_KG = 69;     // ≈ 31 kcal/lb/day fat-store supply ceiling
  const LEAN_KCAL_PER_KG = 1800;  // approx energy density of lean (mostly muscle) tissue
  const deficit = tdee - activeCals;                       // kcal/day below TDEE (>0 = deficit)
  const pctBWperWk = Math.abs(impliedRate / macroWeight) * 100;
  const deficitPctTDEE = tdee > 0 ? (deficit / tdee) * 100 : 0;
  const fatMassKg = avgBf != null ? macroWeight * (avgBf / 100) : null;
  const fatCeiling = fatMassKg != null ? Math.round(fatMassKg * FAT_KCAL_PER_KG) : null;
  const overCeiling = fatCeiling != null ? Math.max(0, deficit - fatCeiling) : null; // kcal/day from lean
  const leanLoss14 = overCeiling != null ? (overCeiling / LEAN_KCAL_PER_KG) * 14 : null; // kg over 14d
  let bmr = null;
  if (profile && profile.heightCm) {
    const age = ageFromDOB(profile.dob);
    if (age != null) bmr = Math.round(10 * macroWeight + 6.25 * profile.heightCm - 5 * age + (profile.sex === "female" ? -161 : 5));
  }
  const belowBMR = bmr != null && activeCals < bmr;
  let riskLevel = "none"; // "none" | "caution" | "high"
  if (deficit > 0) {
    if (pctBWperWk > 1.5 || belowBMR || (overCeiling != null && overCeiling > 150)) riskLevel = "high";
    else if (pctBWperWk > 1.0 || deficitPctTDEE > 25 || (overCeiling != null && overCeiling > 0)) riskLevel = "caution";
  }
  const riskColor = riskLevel === "high" ? "#f87171" : "#fbbf24";

  return (
    <div style={{ marginTop: 24 }}>
      {/* Calorie + phase header */}
      <div style={{ background: phaseInfo.color + "1a", border: `1px solid ${phaseInfo.color}40`, borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: phaseInfo.color + "99", fontWeight: 600, marginBottom: 6 }}>
          {phaseInfo.label}{phase !== "maintain" ? ` · ${magInfo?.label}` : ""} — {isOverridden ? "What-if Intake" : "Daily Intake"}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 30, fontWeight: 800, color: phaseInfo.color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.03em" }}>{activeCals.toLocaleString()}</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>kcal/day</span>
          {isOverridden && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>(target {target.toLocaleString()})</span>}
          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>at {macroWeight.toFixed(1)} kg</span>
        </div>
      </div>

      {/* What-if slider */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600 }}>What-if preview</span>
          {isOverridden && (
            <button onClick={() => setWhatIf(null)} style={{ background: "none", border: "none", color: "#6366f1", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Reset to target</button>
          )}
        </div>
        <input
          type="range" min={sliderMin} max={sliderMax} step={25}
          value={activeCals}
          onChange={e => setWhatIf(Number(e.target.value))}
          style={{ width: "100%", accentColor: phaseInfo.color }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--text-dim)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
          <span>{sliderMin.toLocaleString()}</span>
          <span>TDEE {tdee.toLocaleString()}</span>
          <span>{sliderMax.toLocaleString()}</span>
        </div>
        <div style={{ marginTop: 12, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Projected rate:</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: impliedRate < 0 ? "#34d399" : impliedRate > 0 ? "#60a5fa" : "var(--text-soft)", fontVariantNumeric: "tabular-nums" }}>
            {impliedRate >= 0 ? "+" : ""}{impliedRate.toFixed(2)} kg/wk
          </span>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            ({((impliedRate / macroWeight) * 100).toFixed(2)}% BW/wk · {(activeCals - tdee) >= 0 ? "+" : ""}{(activeCals - tdee).toLocaleString()} kcal vs TDEE)
          </span>
        </div>
        <div style={{ fontSize: 10, color: "var(--border-strong)", marginTop: 6, lineHeight: 1.5 }}>
          Drag to see how a different daily intake would change your weekly rate and the macro split below. This is a preview only — it doesn't change your saved target.
        </div>

        {riskLevel !== "none" && (
          <div style={{ marginTop: 12, background: riskColor + "1a", border: `1px solid ${riskColor}55`, borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 12 }}>{riskLevel === "high" ? "🛑" : "⚠️"}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: riskColor, letterSpacing: "0.02em" }}>
                {riskLevel === "high" ? "Aggressive deficit — lean-mass loss likely" : "Steep deficit — watch lean mass & adherence"}
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-soft)", lineHeight: 1.55 }}>
              At {activeCals.toLocaleString()} kcal you're ~{deficit.toLocaleString()} kcal/day under TDEE
              {" "}({pctBWperWk.toFixed(1)}% BW/wk · {deficitPctTDEE.toFixed(0)}% of TDEE).
              {fatCeiling != null && (
                overCeiling > 0
                  ? ` Your fat stores can supply only ~${fatCeiling.toLocaleString()} kcal/day (≈${fatMassKg.toFixed(1)} kg fat mass × ~31 kcal/lb, Alpert 2005); the ~${overCeiling.toLocaleString()} kcal/day beyond that is drawn largely from lean tissue — on the order of ~${leanLoss14.toFixed(1)} kg of lean mass over 14 days if held (rough estimate; real partitioning varies with leanness, protein and training).`
                  : ` This still sits within what your fat stores can supply (~${fatCeiling.toLocaleString()} kcal/day from ≈${fatMassKg.toFixed(1)} kg fat mass), so most loss should be fat — provided protein and training stay high.`
              )}
              {fatCeiling == null && " Add a body-fat % in your morning log to estimate how much of this deficit your fat stores can fuel before lean tissue is tapped."}
              {belowBMR && ` This intake is also below your estimated BMR (~${bmr.toLocaleString()} kcal) — not sustainable beyond brief periods.`}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5, marginTop: 6 }}>
              Evidence (Garthe 2011; Helms 2014) favours ~0.5–1% BW/wk to retain muscle and strength. If you go this low, keep it short, hold protein high ({phase === "cut" ? "2.2–2.4" : "≥2.0"} g/kg), and keep resistance training in.
            </div>
          </div>
        )}
        {riskLevel === "none" && deficit > 0 && (
          <div style={{ marginTop: 10, fontSize: 10, color: "#34d399", lineHeight: 1.5 }}>
            ✓ ~{pctBWperWk.toFixed(1)}% BW/wk — within the evidence-based range for retaining lean mass (Helms 2014; Garthe 2011).
          </div>
        )}
      </div>

      {/* Split bar */}
      <div style={{ marginBottom: 6 }}>
        <MacroBar macros={m2} phaseColor={phaseInfo.color} />
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 18, fontSize: 10, color: "var(--text-muted)" }}>
        <span><span style={{ color: "#f472b6" }}>●</span> Protein {m2.pctProtein}%</span>
        <span><span style={{ color: "#fbbf24" }}>●</span> Carbs {m2.pctCarbs}%</span>
        <span><span style={{ color: "#60a5fa" }}>●</span> Fat {m2.pctFat}%</span>
      </div>

      {/* Macro cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
        {macroCards.map(m => (
          <div key={m.key} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 14px 14px", borderTop: `3px solid ${m.color}` }}>
            <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600, marginBottom: 10 }}>{m.label}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: m.color, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.03em" }}>{m.grams}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>g</span>
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>{m.cals.toLocaleString()} kcal · {m.pct}%</div>
            <div style={{ fontSize: 10, color: "var(--border-strong)", marginTop: 2 }}>{m.note}</div>
          </div>
        ))}
      </div>

      {/* Per-meal helper */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 10 }}>Per meal (across 4)</div>
        <div style={{ display: "flex", gap: 18, fontSize: 12, color: "var(--text-soft)", fontVariantNumeric: "tabular-nums" }}>
          <span><span style={{ color: "#f472b6", fontWeight: 700 }}>{Math.round(m2.proteinG / 4)}g</span> protein</span>
          <span><span style={{ color: "#fbbf24", fontWeight: 700 }}>{Math.round(m2.carbsG / 4)}g</span> carbs</span>
          <span><span style={{ color: "#60a5fa", fontWeight: 700 }}>{Math.round(m2.fatG / 4)}g</span> fat</span>
        </div>
      </div>

      {/* Rationale */}
      <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6 }}>
        Protein set first at {m2.proteinPerKg.toFixed(1)} g/kg{phase === "cut" ? " (elevated to spare lean mass in a deficit)" : phase === "bulk" ? " (sufficient for hypertrophy in a surplus)" : ""}, fat at {m2.fatPerKg.toFixed(1)} g/kg (≥0.6 g/kg hormonal floor), carbohydrate fills the remainder as training fuel. Method per Helms / ISSN position stands and the framework popularized by Nippard &amp; Ethier. Recalculates as your bodyweight and phase change.
      </div>
    </div>
  );
}

function ProfileModal({ profile, age, baselineTDEE, onSave, onClose }) {
  const [dob, setDob] = useState(profile.dob || "");
  const [ft, setFt] = useState(profile.heightCm ? Math.floor(profile.heightCm / 30.48) : "");
  const [inch, setInch] = useState(profile.heightCm ? Math.round((profile.heightCm / 2.54) % 12) : "");
  const [sex, setSex] = useState(profile.sex || "male");
  const [activity, setActivity] = useState(profile.activity || 1.55);

  const heightCm = ft !== "" ? (Number(ft) * 30.48 + Number(inch || 0) * 2.54) : profile.heightCm;
  const liveAge = ageFromDOB(dob);

  const handleSave = () => {
    onSave({ dob, heightCm: Math.round(heightCm * 10) / 10, sex, activity: Number(activity) });
  };

  const field = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", color: "var(--text)", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" };
  const lbl = { display: "block", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "22px 22px 18px", width: "100%", maxWidth: 380, boxShadow: "0 20px 60px var(--overlay)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)" }}>Profile</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Date of birth{liveAge != null ? ` · age ${liveAge}` : ""}</label>
          <input type="date" value={dob} max={formatDate(new Date())} onChange={e => setDob(e.target.value)} style={field} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Height</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="number" value={ft} onChange={e => setFt(e.target.value)} style={{ ...field, width: 70 }} />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ft</span>
            <input type="number" value={inch} onChange={e => setInch(e.target.value)} style={{ ...field, width: 70 }} />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>in</span>
            <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{heightCm ? `${heightCm.toFixed(1)} cm` : ""}</span>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Biological sex (for BMR equation)</label>
          <div style={{ display: "flex", gap: 8 }}>
            {["male", "female"].map(s => (
              <button key={s} onClick={() => setSex(s)}
                style={{ flex: 1, background: sex === s ? "var(--surface-2)" : "transparent", border: `1px solid ${sex === s ? "#6366f1" : "var(--border)"}`, borderRadius: 6, padding: "8px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: sex === s ? "#a5b4fc" : "var(--text-muted)", textTransform: "capitalize" }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>Activity (outside logged training)</label>
          <div style={{ display: "grid", gap: 6 }}>
            {ACTIVITY_LEVELS.map(a => (
              <button key={a.value} onClick={() => setActivity(a.value)}
                style={{ textAlign: "left", background: activity === a.value ? "var(--surface-2)" : "transparent", border: `1px solid ${activity === a.value ? "#6366f1" : "var(--border)"}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer" }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: activity === a.value ? "#a5b4fc" : "var(--text-soft)" }}>{a.label}</span>
                <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 6 }}>×{a.value} · {a.sub}</span>
              </button>
            ))}
          </div>
        </div>

        {baselineTDEE != null && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 14, lineHeight: 1.5 }}>
            Baseline TDEE at current settings: <span style={{ color: "#34d399", fontWeight: 600 }}>{baselineTDEE.toLocaleString()} kcal</span>. Used as a starting target until ~10 days of data enable a measured TDEE.
          </div>
        )}

        <button onClick={handleSave} style={{ width: "100%", background: "#6366f1", color: "#fff", border: "none", borderRadius: 8, padding: "11px", fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer" }}>
          Save Profile
        </button>
      </div>
    </div>
  );
}

function GoalModal({ goal, latestWeight, latestBf, onSave, onClear, onClose }) {
  const [weight, setWeight] = useState(goal?.weightKg ?? "");
  const [bf, setBf] = useState(goal?.bfPercent ?? "");
  const [date, setDate] = useState(goal?.date ?? "");
  const field = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "9px 11px", color: "var(--text)", fontSize: 14, outline: "none", width: "100%", boxSizing: "border-box" };
  const lbl = { display: "block", fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 };
  const minDate = formatDate(new Date(Date.now() + 86400000));
  
  // Calculate pace warning - only if all needed values present
  let paceWarning = null;
  const hasWeight = weight !== "" && !isNaN(Number(weight));
  const hasDate = date !== "";
  const hasLatestWeight = latestWeight != null && latestWeight > 0;
  
  if (hasWeight && hasDate && hasLatestWeight) {
    const targetWeight = Number(weight);
    const today = new Date();
    const goalDate = new Date(date + "T00:00:00");
    const daysToGoal = Math.ceil((goalDate - today) / 86400000);
    const weeksToGoal = daysToGoal / 7;
    
    if (weeksToGoal > 0) {
      const weightChange = targetWeight - latestWeight;
      const ratePerWeek = weightChange / weeksToGoal;
      const pctBWPerWeek = Math.abs((ratePerWeek / latestWeight) * 100);
      
      if (pctBWPerWeek > 1.0) {
        const severity = pctBWPerWeek > 1.5 ? "high" : "caution";
        const msg = severity === "high" 
          ? "Very steep — high risk of LBM loss (cut) or excess fat gain (bulk)"
          : "Aggressive pace — maintain high protein + resistance training";
        paceWarning = { severity, ratePerWeek, pctBWPerWeek, message: msg };
      }
    }
  }
  
  const save = () => {
    if (weight !== "") {
      const data = { weightKg: Number(weight), date: date || null };
      if (bf !== "") data.bfPercent = Number(bf);
      onSave(data);
    }
  };
  const diff = (weight !== "" && latestWeight != null) ? Number(weight) - latestWeight : null;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "22px 22px 18px", width: "100%", maxWidth: 360, boxShadow: "0 20px 60px var(--overlay)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)" }}>Goal</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Target weight (kg){diff != null ? ` · ${diff > 0 ? "+" : ""}${diff.toFixed(1)} from now` : ""}</label>
          <input type="number" inputMode="decimal" value={weight} placeholder="e.g. 80.0" onChange={e => setWeight(e.target.value)} style={field} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={lbl}>Target body fat % (optional)</label>
          <input type="number" inputMode="decimal" value={bf} placeholder="e.g. 15.0" onChange={e => setBf(e.target.value)} style={field} />
        </div>
        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>Target date (optional)</label>
          <input type="date" value={date} min={minDate} onChange={e => setDate(e.target.value)} style={field} />
        </div>
        {paceWarning && (
          <div style={{ marginBottom: 14, background: paceWarning.severity === "high" ? "#f8717120" : "#fbbf2420", border: `1px solid ${paceWarning.severity === "high" ? "#f87171" : "#fbbf24"}40`, borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: paceWarning.severity === "high" ? "#f87171" : "#fbbf24", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <span>{paceWarning.severity === "high" ? "🛑" : "⚠️"}</span>
              <span>{Math.abs(paceWarning.ratePerWeek).toFixed(2)} kg/wk · {paceWarning.pctBWPerWeek.toFixed(1)}% BW/wk</span>
            </div>
            <div style={{ fontSize: 9.5, color: "var(--text-dim)", lineHeight: 1.4 }}>
              {paceWarning.message}
            </div>
          </div>
        )}
        <button onClick={save} disabled={weight === ""} style={{ width: "100%", background: weight === "" ? "var(--border)" : "#6366f1", color: weight === "" ? "var(--text-dim)" : "#fff", border: "none", borderRadius: 8, padding: "11px", fontSize: 13, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", cursor: weight === "" ? "default" : "pointer", marginBottom: goal ? 8 : 0 }}>
          Save Goal
        </button>
        {goal && (
          <button onClick={onClear} style={{ width: "100%", background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 8, padding: "9px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Clear goal
          </button>
        )}
      </div>
    </div>
  );
}

const PHASE_META = {
  cut: { label: "Cut", color: "#f87171" },
  bulk: { label: "Bulk", color: "#60a5fa" },
  maintain: { label: "Maintain", color: "#34d399" },
};
const MAG_LABEL = {
  aggressive: "Aggressive", moderate: "Moderate", conservative: "Conservative", maintain: "Maintenance",
};

function StatsView({ adherence, phaseHist, onDeletePhase, onEditPhaseDate, weekly, goalInfo, phase }) {
  const [editingDate, setEditingDate] = useState(null); // the original date being edited
  const [editValue, setEditValue] = useState("");
  const sortedHist = [...(phaseHist || [])].sort((a, b) => b.date.localeCompare(a.date));

  // Plain-English weekly verdict
  const weeklyLine = (() => {
    if (!weekly) return null;
    const parts = [];
    if (weekly.wkWeightChange != null) {
      const w = weekly.wkWeightChange;
      parts.push(`${w >= 0 ? "up" : "down"} ${Math.abs(w).toFixed(2)} kg`);
    }
    if (weekly.avgCalThis != null) parts.push(`averaged ${Math.round(weekly.avgCalThis).toLocaleString()} kcal`);
    if (weekly.proteinTarget && weekly.proteinTracked > 0) parts.push(`hit protein ${weekly.proteinHit}/${weekly.proteinTracked} logged days`);
    let verdict = "";
    if (goalInfo && !goalInfo.atGoal && goalInfo.onPace != null) verdict = goalInfo.onPace ? " — on pace for your goal." : " — slightly behind goal pace.";
    else if (goalInfo?.atGoal) verdict = " — at your goal weight.";
    return parts.length ? `This week: ${parts.join(", ")}${verdict}` : null;
  })();

  return (
    <div style={{ marginTop: 24 }}>
      {/* Weekly summary */}
      {weekly && (
        <>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Weekly Summary</div>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 18px", marginBottom: 24 }}>
            {weeklyLine && <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.55, marginBottom: 14, fontWeight: 500 }}>{weeklyLine}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 5 }}>Weight</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: weekly.wkWeightChange == null ? "var(--text-muted)" : weekly.wkWeightChange < 0 ? "#34d399" : "#60a5fa" }}>
                  {weekly.wkWeightChange != null ? `${weekly.wkWeightChange >= 0 ? "+" : ""}${weekly.wkWeightChange.toFixed(2)} kg` : "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 5 }}>Avg calories</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "#6366f1" }}>
                  {weekly.avgCalThis != null ? Math.round(weekly.avgCalThis).toLocaleString() : "—"}
                </div>
                {weekly.calDelta != null && (
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{weekly.calDelta >= 0 ? "+" : ""}{Math.round(weekly.calDelta)} vs prior wk</div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 5 }}>Logged</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>{weekly.calLogged}/7</div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{weekly.wtLogged}/7 weigh-ins</div>
              </div>
            </div>
            {weekly.proteinTarget && weekly.proteinTracked === 0 && (
              <div style={{ fontSize: 10, color: "var(--border-strong)", marginTop: 12, lineHeight: 1.5 }}>
                Tip: log protein in the evening card to see how often you hit your {weekly.proteinTarget} g target.
              </div>
            )}
          </div>
        </>
      )}

      {/* Adherence */}
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Consistency</div>
      {adherence ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
            {[
              { label: "Current streak", value: adherence.streak, unit: adherence.streak === 1 ? "day" : "days", color: "#f472b6" },
              { label: "Last 7 days", value: `${adherence.cov7}%`, unit: "logged", color: "#34d399" },
              { label: "Last 28 days", value: `${adherence.cov28}%`, unit: "logged", color: "#60a5fa" },
            ].map(s => (
              <div key={s.label} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "13px 14px" }}>
                <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 7 }}>{s.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: s.color, fontVariantNumeric: "tabular-nums" }}>{s.value}</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{s.unit}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px", marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-soft)", marginBottom: 10 }}>
              <span>Calories logged</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{adherence.calDays}/{adherence.spanDays} days · {adherence.calPct}%</span>
            </div>
            <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden", marginBottom: 14 }}>
              <div style={{ width: `${adherence.calPct}%`, height: "100%", background: "#6366f1" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-soft)", marginBottom: 10 }}>
              <span>Weight logged</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{adherence.wtDays}/{adherence.spanDays} days · {adherence.wtPct}%</span>
            </div>
            <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${adherence.wtPct}%`, height: "100%", background: "#8b5cf6" }} />
            </div>
            <div style={{ fontSize: 10, color: "var(--border-strong)", marginTop: 12 }}>
              {adherence.totalLogged} total days logged over a {adherence.spanDays}-day span since your first entry.
            </div>
          </div>
        </>
      ) : (
        <div style={{ background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 8, padding: "32px 0", textAlign: "center", color: "var(--border-strong)", fontSize: 12, marginBottom: 24 }}>
          Log some entries to see consistency stats.
        </div>
      )}

      {/* Phase history */}
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Phase History</div>
      {sortedHist.length > 0 ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {sortedHist.map((h, i) => {
            const meta = PHASE_META[h.phase] || { label: h.phase, color: "var(--text-muted)" };
            const next = sortedHist[i - 1]; // more recent (later date)
            const prev = sortedHist[i + 1]; // older (earlier date)
            const endDate = next ? next.date : null;
            const durDays = (() => {
              const start = new Date(h.date + "T00:00:00");
              const end = endDate ? new Date(endDate + "T00:00:00") : new Date(formatDate(new Date()) + "T00:00:00");
              return Math.max(0, Math.round((end - start) / 86400000));
            })();
            const isEditing = editingDate === h.date;
            // Valid range: strictly after the older record, strictly before the newer one (or today)
            const minDate = prev ? addDaysStr(prev.date, 1) : undefined;
            const maxDate = next ? addDaysStr(next.date, -1) : formatDate(new Date());
            return (
              <div key={h.date + i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: i < sortedHist.length - 1 ? "1px solid var(--surface-2)" : "none" }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: meta.color, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: meta.color }}>
                    {meta.label}{h.phase !== "maintain" && h.magnitude ? ` · ${MAG_LABEL[h.magnitude] || h.magnitude}` : ""}
                  </div>
                  {isEditing ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      <input type="date" value={editValue} min={minDate} max={maxDate}
                        onChange={e => setEditValue(e.target.value)}
                        style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", color: "var(--text)", fontSize: 12 }} />
                      <button onClick={() => { if (editValue) onEditPhaseDate(h.date, editValue); setEditingDate(null); }}
                        style={{ background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                        Save
                      </button>
                      <button onClick={() => setEditingDate(null)}
                        style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                      {h.date}{endDate ? ` → ${endDate}` : " → now"} · {durDays}d{h.weightKg != null ? ` · started ${h.weightKg.toFixed(1)} kg` : ""}
                    </div>
                  )}
                </div>
                {!isEditing && (
                  <>
                    <button onClick={() => { setEditingDate(h.date); setEditValue(h.date); }}
                      style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}>
                      Edit
                    </button>
                    <button onClick={() => onDeletePhase(h.date)} style={{ background: "none", border: "none", color: "var(--border-strong)", cursor: "pointer", fontSize: 12 }}>✕</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 8, padding: "32px 0", textAlign: "center", color: "var(--border-strong)", fontSize: 12 }}>
          Phase changes will be recorded here as you switch between bulk, cut, and maintain.
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({ title, message, actions, onClose }) {
  const btnStyle = (style) => {
    if (style === "primary") return { background: "#6366f1", color: "#fff", border: "none" };
    if (style === "danger") return { background: "#f87171", color: "#1a0a0a", border: "none" };
    return { background: "transparent", color: "var(--text-soft)", border: "1px solid var(--border)" };
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 300, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 14, padding: "22px", width: "100%", maxWidth: 340, boxShadow: "0 20px 60px var(--shadow)" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 10 }}>{title}</div>
        {message && <div style={{ fontSize: 12.5, color: "var(--text-soft)", lineHeight: 1.55, marginBottom: 18 }}>{message}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {actions.map((a, i) => (
            <button key={i} onClick={a.onClick}
              style={{ ...btnStyle(a.style), borderRadius: 8, padding: "10px", fontSize: 13, fontWeight: 600, letterSpacing: "0.03em", cursor: "pointer" }}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReportView({ reportRange, setReportRange, reportCustomStart, setReportCustomStart, reportCustomEnd, setReportCustomEnd, reportData, onExportMD, onCopyMD, onExportPDF }) {
  const r = reportData;
  const fmt1 = (v) => v != null ? v.toFixed(1) : "—";
  const fmt2 = (v) => v != null ? v.toFixed(2) : "—";

  return (
    <div style={{ marginTop: 24 }}>
      {/* Range selector */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 14 }}>
        {Object.entries(REPORT_RANGES).map(([key, info]) => {
          const active = reportRange === key;
          return (
            <button key={key} onClick={() => setReportRange(key)}
              style={{
                background: active ? "var(--surface-2)" : "transparent",
                border: `1px solid ${active ? "#6366f1" : "var(--border)"}`, borderRadius: 6,
                padding: "8px", cursor: "pointer", fontSize: 11, fontWeight: 600,
                color: active ? "#a5b4fc" : "var(--text-muted)", letterSpacing: "0.04em",
              }}>
              {info.label}
            </button>
          );
        })}
      </div>

      {reportRange === "custom" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 18, flexWrap: "wrap" }}>
          <input type="date" value={reportCustomStart} max={reportCustomEnd || today}
            onChange={e => setReportCustomStart(e.target.value)}
            style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", color: "var(--text)", fontSize: 12 }} />
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>to</span>
          <input type="date" value={reportCustomEnd} min={reportCustomStart} max={today}
            onChange={e => setReportCustomEnd(e.target.value)}
            style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", color: "var(--text)", fontSize: 12 }} />
        </div>
      )}

      {/* Export buttons */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        <button onClick={onExportPDF}
          style={{ background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, padding: "9px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          Export PDF
        </button>
        <button onClick={onExportMD}
          style={{ background: "transparent", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "9px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          Download .md
        </button>
        <button onClick={onCopyMD}
          style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6, padding: "9px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          Copy
        </button>
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 18 }}>
        {r.startDate} → {r.endDate} · {r.spanDays} days · {r.entryCount} entries logged
      </div>

      {/* Overview */}
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Overview</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24 }}>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "13px 14px" }}>
          <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 7 }}>Weight</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#8b5cf6" }}>{fmt1(r.startWeight)} → {fmt1(r.endWeight)} kg</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>
            {r.weightChangePerWeek != null ? `${r.weightChangePerWeek >= 0 ? "+" : ""}${fmt2(r.weightChangePerWeek)} kg/wk` : "insufficient data"}
          </div>
        </div>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "13px 14px" }}>
          <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 7 }}>Body Fat</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#a78bfa" }}>{fmt1(r.startBf)}% → {fmt1(r.endBf)}%</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>
            {r.bfChange != null ? `${r.bfChange >= 0 ? "+" : ""}${fmt2(r.bfChange)} pts total` : "insufficient data"}
          </div>
        </div>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "13px 14px" }}>
          <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 7 }}>Avg Calories</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#6366f1" }}>{r.avgCalories != null ? Math.round(r.avgCalories).toLocaleString() : "—"}</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>kcal/day · {r.calLogPct}% of days logged</div>
        </div>
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "13px 14px" }}>
          <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 7 }}>Avg Protein</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#f472b6" }}>{r.avgProtein != null ? Math.round(r.avgProtein) : "—"}</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>{r.avgProtein != null ? "g/day" : "not tracked"}</div>
        </div>
      </div>

      {/* Adherence */}
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Adherence</div>
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px", marginBottom: 24 }}>
        {r.targetComparable > 0 ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-soft)", marginBottom: 8 }}>
              <span>On/near target</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.onTargetDays}/{r.targetComparable} days ({Math.round((r.onTargetDays / r.targetComparable) * 100)}%)</span>
            </div>
            <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden", marginBottom: 10 }}>
              <div style={{ width: `${Math.round((r.onTargetDays / r.targetComparable) * 100)}%`, height: "100%", background: "#34d399" }} />
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)" }}>Over: {r.overDays} days · Under: {r.underDays} days</div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Not enough logged data with a known target to assess.</div>
        )}
        {r.proteinTracked > 0 && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--surface-2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-soft)", marginBottom: 8 }}>
              <span>Protein target hit</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{r.proteinHitDays}/{r.proteinTracked} days ({Math.round((r.proteinHitDays / r.proteinTracked) * 100)}%)</span>
            </div>
            <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${Math.round((r.proteinHitDays / r.proteinTracked) * 100)}%`, height: "100%", background: "#f472b6" }} />
            </div>
          </div>
        )}
      </div>

      {/* Phases in range */}
      {r.phasesInRange.length > 0 && (
        <>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Phases in this period</div>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 16px", marginBottom: 24 }}>
            {r.phasesInRange.map((h, i) => {
              const meta = PHASE_META[h.phase] || { label: h.phase, color: "var(--text-muted)" };
              return (
                <div key={h.date + i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: i < r.phasesInRange.length - 1 ? "1px solid var(--surface-2)" : "none" }}>
                  <div style={{ width: 7, height: 7, borderRadius: 4, background: meta.color }} />
                  <span style={{ fontSize: 12, color: "var(--text)" }}>{h.date} — {meta.label}{h.magnitude ? ` · ${MAG_LABEL[h.magnitude] || h.magnitude}` : ""}</span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Goal */}
      {r.goalSnapshot && !r.goalSnapshot.atGoal && (
        <>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Goal</div>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px", marginBottom: 24, fontSize: 12, color: "var(--text-soft)", lineHeight: 1.5 }}>
            {fmt1(Math.abs(r.goalSnapshot.remaining))} kg {r.goalSnapshot.remaining > 0 ? "to gain" : "to lose"}, current pace {fmt2(r.goalSnapshot.ratePerWeek)} kg/wk —{" "}
            <strong style={{ color: r.goalSnapshot.onPace ? "#34d399" : "#fbbf24" }}>{r.goalSnapshot.onPace ? "on pace" : "behind pace"}</strong>.
          </div>
        </>
      )}

      {/* Insights */}
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Insights &amp; Recommendations</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {r.insights.map((ins, i) => {
          const color = ins.type === "good" ? "#34d399" : ins.type === "warn" ? "#fbbf24" : "var(--text-muted)";
          const icon = ins.type === "good" ? "✓" : ins.type === "warn" ? "⚠" : "ℹ";
          return (
            <div key={i} style={{ display: "flex", gap: 10, background: "var(--surface)", border: "1px solid var(--border)", borderLeft: `3px solid ${color}`, borderRadius: 6, padding: "10px 12px" }}>
              <span style={{ color, fontWeight: 700, fontSize: 12 }}>{icon}</span>
              <span style={{ fontSize: 12, color: "var(--text-soft)", lineHeight: 1.5 }}>{ins.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
