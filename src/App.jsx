import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const STORAGE_KEY = "body-tracker-entries";
const SETTINGS_KEY = "body-tracker-settings";
const PROFILE_KEY = "body-tracker-profile";
const CYCLE_KEY = "body-tracker-cycle";
const GOAL_KEY = "body-tracker-goal";
const PHASEHIST_KEY = "body-tracker-phasehist";
const THEME_KEY = "body-tracker-theme";
const WATER_KEY = "body-tracker-water";
const DIETBREAK_KEY = "body-tracker-diet-break";
const TDEE_KEY = "body-tracker-tdee";
const TDEEPARAMS_KEY = "body-tracker-tdee-params";
const TARGETHIST_KEY = "body-tracker-target-hist";
const DIETBREAKLOG_KEY = "body-tracker-diet-break-log";

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

// ═══ TDEE REVIEW LOGIC — BEGIN (tested copy; edit tdeeReview.js and regenerate, do not hand-edit) ═══
// tdeeReview.js — Stage 1: pure TDEE review logic.
// No React, no localStorage, no UI. Everything here is a plain function so it can be
// tested with fixed numbers. Later stages wire it into App.jsx.
//
// Agreed design (see ticket): regression-based raw TDEE, 25% smoothing toward raw,
// capped change per review, Red -> Amber -> Green confidence, user approval, and
// weigh-in exclusion that removes weight AND body fat together.

// ─── Constants & defaults ────────────────────────────────────────────────────

const TDEE_DEFAULTS = {
  kcalPerKg: 7700,      // single shared energy-equivalent value (configurable)
  windowDays: 14,
  smoothing: 0.25,      // fixed
  cap: 100,             // kcal per review; configurable 50–150 in steps of 5
  firstSmoothing: 0.5,  // first review only
  firstCap: 150,        // first review only
  roundTo: 5,
  snoozeDays: 7,        // Defer
  reviewEveryDays: 14,
  // weigh-in flagging
  suspectAbsKg: 1.0,
  suspectPct: 1.5,
  suspectMinPoints: 6,
  saveMinPoints: 5,
  // confidence thresholds
  scatterSdKg: 0.6,
  rateBWPctPerWeek: 1.0,
  gapAmber: 300,
  gapRed: 500,
  creatineRateKgPerWeek: 0.5,
};

// Confounder flag ids (stored per day as entry.flags = [...ids]).
const FLAGS = {
  HIGH_CARB_SODIUM: "highCarbSodium",
  ALCOHOL: "alcohol",
  HARD_TRAINING: "hardTraining",
  TRAVEL: "travel",
  DIGESTIVE: "digestive",
  ILLNESS: "illness",
  CREATINE: "creatine",
  ACTIVITY_CHANGED: "activityChanged",
  NON_STANDARD_WEIGHIN: "nonStandardWeighIn", // = exclusion of that day's weight AND body fat
  CALORIES_INCOMPLETE: "caloriesIncomplete",
  OTHER: "other",
  WEIGHT_CONFIRMED: "weightConfirmed", // internal: user confirmed this reading is real, so never ask again
};

// A day counts as a "confounder day" if it has any of these. Training/DOMS,
// incomplete calories and non-standard weigh-in have their own rules, so they are
// not double-counted here.
const CONFOUNDER_DAY_FLAGS = [
  FLAGS.HIGH_CARB_SODIUM, FLAGS.ALCOHOL, FLAGS.TRAVEL, FLAGS.DIGESTIVE,
  FLAGS.ILLNESS, FLAGS.CREATINE, FLAGS.ACTIVITY_CHANGED, FLAGS.OTHER,
];

// ─── Small helpers ───────────────────────────────────────────────────────────

// Dates are YYYY-MM-DD strings. Work in UTC day numbers so DST never shifts a day.
const dayNum = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const addDays = (s, n) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const roundTo = (v, step) => Math.round(v / step) * step;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

const hasFlag = (entry, id) => Array.isArray(entry?.flags) && entry.flags.includes(id);

// ─── Shared "valid readings" step ────────────────────────────────────────────
// One place that decides whether a day's weight / body fat may be used. Every screen
// that reads weight or body fat should go through this (Stage 2 wires that up).
// A non-standard weigh-in removes weight AND body fat together; the raw entry is
// never changed, so history is kept.

function validReading(entry) {
  if (!entry) return { weight: null, bf: null, excluded: false };
  const excluded = hasFlag(entry, FLAGS.NON_STANDARD_WEIGHIN);
  return {
    weight: !excluded && entry.weight != null ? Number(entry.weight) : null,
    bf: !excluded && entry.bf != null ? Number(entry.bf) : null,
    excluded: excluded && (entry.weight != null || entry.bf != null),
  };
}

// ─── Weigh-in flagging (detect, then the user confirms) ──────────────────────
// Rule: flag a weight that is more than 1.0 kg AND more than 1.5% away from the
// trend line for that date.

const isSuspect = (deviation, expected, p) =>
  Math.abs(deviation) > p.suspectAbsKg && (Math.abs(deviation) / expected) * 100 > p.suspectPct;

// Review-time: leave-one-out, worst first. Each weight is compared with the line fitted to
// all the OTHER weights still in the set. The single worst offender is flagged, removed, and
// the rest are re-checked against the re-fitted line — so one spike can't make its normal-
// looking neighbours look odd. points: [{date, weight}]
function detectSuspectWeights(points, params = {}, skipDates = []) {
  const p = { ...TDEE_DEFAULTS, ...params };
  const skip = new Set(skipDates); // confirmed-normal days: stay in the fit, are never flagged
  let pool = points.slice();
  const out = [];
  while (pool.length >= p.suspectMinPoints) {
    let worst = null;
    for (let i = 0; i < pool.length; i++) {
      if (skip.has(pool[i].date)) continue;
      const others = pool.filter((_, j) => j !== i).map((q) => ({ x: dayNum(q.date), y: q.weight }));
      const reg = linReg(others);
      if (!reg) continue;
      const expected = reg.slope * dayNum(pool[i].date) + reg.intercept;
      const deviation = pool[i].weight - expected;
      if (isSuspect(deviation, expected, p) && (!worst || Math.abs(deviation) > Math.abs(worst.deviation))) {
        worst = { date: pool[i].date, weight: pool[i].weight, expected, deviation };
      }
    }
    if (!worst) break;
    out.push(worst);
    pool = pool.filter((q) => q.date !== worst.date);
  }
  return out;
}

// Save-time: compare a new weight with the trend of the previous 14 days (extrapolated).
// Returns null if fine or not enough history, else {expected, deviation}.
function checkNewWeight({ date, weight, entries, params = {} }) {
  const p = { ...TDEE_DEFAULTS, ...params };
  const pts = [];
  for (let i = 1; i <= p.windowDays; i++) {
    const d = addDays(date, -i);
    const w = validReading(entries[d]).weight;
    if (w != null) pts.push({ x: dayNum(d), y: w });
  }
  if (pts.length < p.saveMinPoints) return null;
  const reg = linReg(pts);
  if (!reg) return null;
  const expected = reg.slope * dayNum(date) + reg.intercept;
  const deviation = weight - expected;
  return isSuspect(deviation, expected, p) ? { expected, deviation } : null;
}

// ─── The review ──────────────────────────────────────────────────────────────

// Build the 14 calendar days ending yesterday. Today is never included (its calories
// are not final). windowFloor (optional) stops a review reaching back before the last
// accepted/kept review, which is what prevents the same days being counted twice.
function buildWindow(entries, today, p, windowFloor) {
  const end = addDays(today, -1);
  const start = addDays(end, -(p.windowDays - 1));
  const startNum = dayNum(start);
  const days = [];
  for (let i = 0; i < p.windowDays; i++) {
    const date = addDays(start, i);
    const inScope = !(windowFloor && date < windowFloor);
    const e = inScope ? entries[date] : undefined;
    const vr = validReading(e);
    const calories = e?.calories != null ? Number(e.calories) : null;
    days.push({
      date, idx: i, week: i < 7 ? 1 : 2, x: dayNum(date) - startNum,
      calories,
      complete: calories != null && !hasFlag(e, FLAGS.CALORIES_INCOMPLETE),
      weight: vr.weight, excludedWeighIn: vr.excluded,
      flags: e?.flags || [],
    });
  }
  return { start, end, days };
}

const longestRun = (days, pred) => {
  let best = 0, run = 0;
  for (const d of days) { run = pred(d) ? run + 1 : 0; best = Math.max(best, run); }
  return best;
};

function assessReview({
  entries,
  today,
  currentTDEE,
  phaseHist = [],
  dietBreakLog = [],   // [{start, end|null}]
  isFirstReview = false,
  priorLargeGapStreak = 0,
  windowFloor = null,
  params = {},
}) {
  const p = { ...TDEE_DEFAULTS, ...params };
  const { start, end, days } = buildWindow(entries, today, p, windowFloor);

  // ── Counts ──
  const calorieDays = days.filter((d) => d.calories != null).length;
  const completeDays = days.filter((d) => d.complete).length;
  const validDays = days.filter((d) => d.weight != null);
  const validWeighIns = validDays.length;
  const validWeek1 = validDays.filter((d) => d.week === 1).length;
  const validWeek2 = validDays.filter((d) => d.week === 2).length;
  const excludedWeighIns = days.filter((d) => d.excludedWeighIn).length;
  const incompleteRun = longestRun(days, (d) => !d.complete);

  // ── Regression on valid weights → weekly rate → surplus → raw TDEE ──
  const reg = validDays.length >= 2 ? linReg(validDays.map((d) => ({ x: d.x, y: d.weight }))) : null;
  const slopePerDay = reg ? reg.slope : null;
  const weeklyRate = slopePerDay != null ? slopePerDay * 7 : null;               // kg / week
  const dailySurplus = slopePerDay != null ? slopePerDay * p.kcalPerKg : null;   // = weekly × kcalPerKg ÷ 7
  const meanWeight = mean(validDays.map((d) => d.weight));
  const weeklyPct = weeklyRate != null && meanWeight ? (weeklyRate / meanWeight) * 100 : null;
  let scatterSd = null;
  if (reg && validDays.length > 2) {
    const ss = validDays.reduce((s, d) => s + (d.weight - (reg.slope * d.x + reg.intercept)) ** 2, 0);
    scatterSd = Math.sqrt(ss / (validDays.length - 2)); // residual standard error
  }
  const avgCalories = mean(days.filter((d) => d.complete).map((d) => d.calories));
  const rawTDEE = avgCalories != null && dailySurplus != null ? avgCalories - dailySurplus : null;
  const gap = rawTDEE != null && currentTDEE != null ? rawTDEE - currentTDEE : null;

  // ── Flag counts ──
  const countFlag = (id) => days.filter((d) => d.flags.includes(id)).length;
  const confounderDays = days.filter((d) => d.flags.some((f) => CONFOUNDER_DAY_FLAGS.includes(f))).length;
  const trainingDays = countFlag(FLAGS.HARD_TRAINING);
  const illnessDays = countFlag(FLAGS.ILLNESS);
  const travelDays = countFlag(FLAGS.TRAVEL);
  const creatineDays = countFlag(FLAGS.CREATINE);

  // ── Phase / diet-break events inside the window (read-only) ──
  const inWin = (d) => d >= start && d <= end;
  const phaseChanges = phaseHist.filter((h) => inWin(h.date)).map((h) => h.date);
  const dietBreakEvents = [];
  for (const b of dietBreakLog) {
    if (inWin(b.start)) dietBreakEvents.push(b.start);
    if (b.end && inWin(b.end)) dietBreakEvents.push(b.end);
  }

  // ── Classification: Red → Amber → Green ──
  const red = [], amber = [];
  const R = (code, text) => red.push({ level: "red", code, text });
  const A = (code, text) => amber.push({ level: "amber", code, text });

  if (rawTDEE == null) R("no_estimate", "Not enough data to estimate TDEE.");
  if (completeDays <= 11) R("complete_days", `Only ${completeDays} of 14 days have a complete calorie log (need 13+).`);
  else if (completeDays === 12) A("complete_days", "12 of 14 days have a complete calorie log (13+ is Green).");
  if (validWeighIns < 10) R("weigh_ins", `Only ${validWeighIns} valid weigh-ins (need 10+).`);
  else if (validWeighIns <= 11) A("weigh_ins", `${validWeighIns} valid weigh-ins (12+ is Green).`);
  if (validWeek1 < 5 || validWeek2 < 5) R("weigh_ins_per_week", `Week 1 has ${validWeek1} and week 2 has ${validWeek2} valid weigh-ins (need 5+ in each).`);
  if (incompleteRun >= 5) R("incomplete_run", `${incompleteRun} incomplete calorie days in a row.`);
  else if (incompleteRun >= 3) A("incomplete_run", `${incompleteRun} incomplete calorie days in a row.`);
  if (excludedWeighIns >= 3) R("excluded_weigh_ins", `${excludedWeighIns} weigh-ins were marked non-standard.`);
  else if (excludedWeighIns >= 1) A("excluded_weigh_ins", `${excludedWeighIns} weigh-in${excludedWeighIns > 1 ? "s were" : " was"} marked non-standard.`);
  if (illnessDays >= 3) R("illness", `Illness or injury flagged on ${illnessDays} days.`);
  else if (illnessDays >= 1) A("illness", `Illness or injury flagged on ${illnessDays} day${illnessDays > 1 ? "s" : ""}.`);
  if (travelDays >= 5) R("travel", `Travel or disrupted routine on ${travelDays} days.`);
  else if (travelDays >= 1) A("travel", `Travel or disrupted routine on ${travelDays} day${travelDays > 1 ? "s" : ""}.`);
  if (creatineDays >= 3 && weeklyRate != null && Math.abs(weeklyRate) > p.creatineRateKgPerWeek) {
    R("creatine", `Creatine change flagged on ${creatineDays} days with fast weight movement.`);
  } else if (creatineDays >= 1) A("creatine", "Creatine change flagged in this period.");
  if (confounderDays >= 7) R("confounders", `${confounderDays} days had confounders (water, sodium, alcohol, etc.).`);
  else if (confounderDays >= 3) A("confounders", `${confounderDays} days had confounders (water, sodium, alcohol, etc.).`);
  if (trainingDays >= 6) A("training", `Hard training or DOMS on ${trainingDays} days.`);
  if ((scatterSd != null && scatterSd > p.scatterSdKg) || (weeklyPct != null && Math.abs(weeklyPct) > p.rateBWPctPerWeek)) {
    A("trend", scatterSd != null && scatterSd > p.scatterSdKg
      ? `Daily weights are scattered (±${scatterSd.toFixed(2)} kg around the trend).`
      : `Weight is changing fast (${weeklyPct.toFixed(1)}% of bodyweight per week).`);
  }
  if (phaseChanges.length) A("phase_change", "A phase change happened inside this window.");
  if (dietBreakEvents.length) A("diet_break", "A diet break or deload started or ended inside this window.");
  if (gap != null) {
    if (Math.abs(gap) > p.gapRed) R("gap", `Raw TDEE is ${Math.round(Math.abs(gap))} kcal ${gap > 0 ? "above" : "below"} your current TDEE.`);
    else if (Math.abs(gap) > p.gapAmber) A("gap", `Raw TDEE is ${Math.round(Math.abs(gap))} kcal ${gap > 0 ? "above" : "below"} your current TDEE.`);
  }

  // A Red caused ONLY by a large gap, with otherwise clean data, is recorded separately:
  // if it repeats, the next review is downgraded to Amber so a wrong starting TDEE can
  // still be corrected (manual Accept, same capped step).
  const gapOnlyRed = red.length === 1 && red[0].code === "gap";
  let escapeRoute = false;
  let redReasons = red;
  if (gapOnlyRed && priorLargeGapStreak >= 1) {
    escapeRoute = true;
    redReasons = [];
    amber.push({ level: "amber", code: "gap_persistent", text: "Your data has been reliable across consecutive reviews, but raw TDEE is still far from your current TDEE. You can accept a capped step toward it." });
  }

  const confidence = redReasons.length ? "red" : amber.length ? "amber" : "green";
  const reasons = [...redReasons, ...amber];

  // ── Smoothing, cap, rounding ──
  // The larger first-review step never applies on the escape route (it may rest on a noisy window).
  const useFirst = isFirstReview && !escapeRoute;
  const smoothing = useFirst ? p.firstSmoothing : p.smoothing;
  const cap = useFirst ? p.firstCap : p.cap;
  let proposedTDEE = null, proposedChange = null, capped = false;
  if (rawTDEE != null && currentTDEE != null) {
    const blended = currentTDEE * (1 - smoothing) + rawTDEE * smoothing;
    const delta = clamp(blended - currentTDEE, -cap, cap);
    capped = Math.abs(blended - currentTDEE) > cap;
    proposedTDEE = roundTo(currentTDEE + delta, p.roundTo);
    proposedChange = proposedTDEE - currentTDEE;
  }

  const confirmedDates = days.filter((d) => d.flags.includes(FLAGS.WEIGHT_CONFIRMED)).map((d) => d.date);
  const suspectWeights = detectSuspectWeights(validDays.map((d) => ({ date: d.date, weight: d.weight })), p, confirmedDates);

  return {
    window: { start, end },
    counts: { calorieDays, completeDays, validWeighIns, validWeek1, validWeek2, excludedWeighIns, incompleteRun, confounderDays, trainingDays, illnessDays, travelDays, creatineDays },
    trend: { weeklyRate, weeklyPct, dailySurplus, scatterSd, meanWeight },
    avgCalories, rawTDEE, currentTDEE, gap,
    proposedTDEE, proposedChange, capped, smoothing, cap, isFirstReview,
    confidence, reasons, escapeRoute, gapOnlyRed,
    phaseChanges, dietBreakEvents,
    suspectWeights, needsWeighInConfirmation: suspectWeights.length > 0,
    canAccept: confidence !== "red" && proposedTDEE != null,
    defaultAction: confidence === "green" ? "accept" : confidence === "amber" ? "keep" : null,
  };
}

// ─── Review schedule (countdown) ─────────────────────────────────────────────
// status: "countdown" | "due" | "rechecking" | "snoozed"
function reviewSchedule({ lastEventDate, snoozedUntil = null, today, lastConfidence = null, params = {} }) {
  const p = { ...TDEE_DEFAULTS, ...params };
  const dueDate = addDays(lastEventDate, p.reviewEveryDays);
  if (snoozedUntil && today < snoozedUntil) return { status: "snoozed", until: snoozedUntil, dueDate };
  if (today < dueDate) return { status: "countdown", daysLeft: dayNum(dueDate) - dayNum(today), dueDate };
  return { status: lastConfidence === "red" ? "rechecking" : "due", dueDate };
}

// ─── Decisions ───────────────────────────────────────────────────────────────
// State (persisted in Stage 2):
// { currentTDEE, source, lastEventDate, lastAcceptDate, snoozedUntil, largeGapStreak, history: [] }
// decision: "accept" | "keep" | "defer" | "auto_keep"
//   accept    — applies the proposed TDEE, starts a fresh 14-day window today.
//   keep      — declines, next review in 14 days.
//   defer     — no decision recorded; prompt hidden for 7 days; window not reset.
//   auto_keep — used when data was clean but the gap was >500 (gap-only Red): recorded as a
//               review so the large-gap streak can build. Does not change TDEE.
function applyDecision(state, decision, review, today, params = {}) {
  const p = { ...TDEE_DEFAULTS, ...params };
  const next = { ...state, history: [...(state.history || [])] };
  const log = (applied) => next.history.push({
    date: today, decision, confidence: review.confidence,
    raw: review.rawTDEE != null ? Math.round(review.rawTDEE) : null,
    proposed: review.proposedTDEE, previous: state.currentTDEE, applied,
    reasons: review.reasons.map((r) => r.code),
  });

  if (decision === "accept") {
    if (!review.canAccept) return state; // Red can never be accepted
    next.currentTDEE = review.proposedTDEE;
    next.source = "accepted";
    next.lastEventDate = today;
    next.lastAcceptDate = today;
    next.snoozedUntil = null;
    next.largeGapStreak = 0;
    log(review.proposedTDEE);
  } else if (decision === "keep" || decision === "auto_keep") {
    next.lastEventDate = today;
    next.snoozedUntil = null;
    next.largeGapStreak = review.gapOnlyRed ? (state.largeGapStreak || 0) + 1 : 0;
    log(state.currentTDEE);
  } else if (decision === "defer") {
    next.snoozedUntil = addDays(today, p.snoozeDays);
    // Defer records nothing in history and does not move lastEventDate.
  }
  return next;
}

// ─── Stage 2 helpers (pure) ──────────────────────────────────────────────────

// Copy of entries with weight/body fat blanked on non-standard weigh-ins. Every screen that
// reads weight or body fat uses this; calories/protein pass through untouched.
function buildValidEntries(entries) {
  const out = {};
  for (const d of Object.keys(entries)) {
    const vr = validReading(entries[d]);
    out[d] = { ...entries[d], weight: vr.weight, bf: vr.bf };
  }
  return out;
}

// Field-level merge per day: incoming fields win only where they exist; a day's flags are kept
// unless the incoming record carries flags.
function mergeEntries(existing, incoming) {
  const out = { ...existing };
  for (const d of Object.keys(incoming)) out[d] = { ...(existing[d] || {}), ...incoming[d] };
  return out;
}

// CSV: date,calories,weight_kg,body_fat_pct,protein_g,flags   (flags joined with "|")
function entriesToCSV(entries) {
  const header = "date,calories,weight_kg,body_fat_pct,protein_g,flags";
  const rows = Object.keys(entries).sort().map((d) => {
    const e = entries[d] || {};
    const n = (v) => (v != null ? Number(v) : "");
    return [d, n(e.calories), n(e.weight), n(e.bf), n(e.protein), Array.isArray(e.flags) ? e.flags.join("|") : ""].join(",");
  });
  return [header, ...rows].join("\n");
}

// Reads the new format and the old 5-column format.
function csvToEntries(text) {
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
    const fl = (cols[5] || "").split("|").map((s) => s.trim()).filter(Boolean);
    if (fl.length) rec.flags = fl;
    if (Object.keys(rec).length) out[date] = rec;
  }
  return out;
}
// ═══ TDEE REVIEW LOGIC — END ═══

const KCAL_PER_KG = TDEE_DEFAULTS.kcalPerKg; // default energy-equivalent value (configurable in Profile)
const FLAG_OPTIONS = [
  { id: FLAGS.HIGH_CARB_SODIUM, label: "High carb / sodium" },
  { id: FLAGS.ALCOHOL, label: "Alcohol" },
  { id: FLAGS.HARD_TRAINING, label: "Hard training / DOMS" },
  { id: FLAGS.TRAVEL, label: "Travel / disrupted routine" },
  { id: FLAGS.DIGESTIVE, label: "Digestive issue" },
  { id: FLAGS.ILLNESS, label: "Illness / injury" },
  { id: FLAGS.CREATINE, label: "Creatine change" },
  { id: FLAGS.ACTIVITY_CHANGED, label: "Activity changed" },
  { id: FLAGS.CALORIES_INCOMPLETE, label: "Calories incomplete" },
  { id: FLAGS.OTHER, label: "Other" },
];

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
function calcTDEEWindow(dated, windowDays, asOfTs = Date.now(), kcalPerKg = KCAL_PER_KG) {
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
  const dailySurplus = dailyKgChange * kcalPerKg;  // kcal/day implied by weight trend
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

const phaseLabel = (p, m) => `${PHASES[p]?.label ?? p}${p !== "maintain" ? " · " + (PHASES[p]?.magnitudes.find(x => x.id === m)?.label || m) : ""}`;

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
  const [view, setView] = useState("daily");
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
  const [waterLog, setWaterLog] = useState({}); // { [date]: { plain: ml, carbMix: ml, gymDay: bool, lastAction: {field,amount}|null } }
  const [dietBreakMode, setDietBreakMode] = useState(null); // { active: bool, startDate: string }
  // Phase history: array of { date, phase, magnitude }
  const [phaseHist, setPhaseHist] = useState([]);
  // Approved TDEE state: { currentTDEE, source, lastEventDate, lastAcceptDate, snoozedUntil, largeGapStreak, history } | null
  const [tdeeState, setTdeeState] = useState(null);
  const [dietBreakLog, setDietBreakLog] = useState([]); // [{ start, end|null }]
  const [morningExcludeEdit, setMorningExcludeEdit] = useState(null); // null = follow saved flag
  const [tdeeParams, setTdeeParams] = useState({ cap: TDEE_DEFAULTS.cap, kcalPerKg: TDEE_DEFAULTS.kcalPerKg });
  const [previewTdee, setPreviewTdee] = useState(false);
  const [flagsOpen, setFlagsOpen] = useState(false);
  const [olderCount, setOlderCount] = useState(0);
  const [targetHist, setTargetHist] = useState([]); // [{ date, target, kind? }] — the calorie target in force from each date
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
      const wl = store.get(WATER_KEY);
      if (wl) setWaterLog(wl);
      const db = store.get(DIETBREAK_KEY);
      if (db) setDietBreakMode(db);
      const ts = store.get(TDEE_KEY);
      if (ts) setTdeeState(ts);
      const dbl = store.get(DIETBREAKLOG_KEY);
      if (Array.isArray(dbl)) setDietBreakLog(dbl);
      const tpar = store.get(TDEEPARAMS_KEY);
      const thist = store.get(TARGETHIST_KEY);
      if (Array.isArray(thist)) setTargetHist(thist);
      if (tpar) setTdeeParams({ cap: tpar.cap ?? TDEE_DEFAULTS.cap, kcalPerKg: tpar.kcalPerKg ?? TDEE_DEFAULTS.kcalPerKg });
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
  const saveWater = (next) => { setWaterLog(next); store.set(WATER_KEY, next); };
  const addWaterAmount = (date, field, ml) => {
    const day = waterLog[date] || { plain: 0, carbMix: 0, gymDay: false };
    saveWater({ ...waterLog, [date]: { ...day, [field]: Math.max(0, (day[field] || 0) + ml), lastAction: { field, amount: ml } } });
  };
  const undoLastWater = (date) => {
    const day = waterLog[date];
    if (!day?.lastAction) return;
    const { field, amount } = day.lastAction;
    saveWater({ ...waterLog, [date]: { ...day, [field]: Math.max(0, (day[field] || 0) - amount), lastAction: null } });
  };
  const toggleGymDay = (date, val) => {
    const day = waterLog[date] || { plain: 0, carbMix: 0, gymDay: false };
    saveWater({ ...waterLog, [date]: { ...day, gymDay: val } });
  };
  const saveDietBreak = (next) => { setDietBreakMode(next); store.set(DIETBREAK_KEY, next); };
  const saveTdeeState = (next) => { setTdeeState(next); store.set(TDEE_KEY, next); };
  const saveTdeeParams = (next) => { setTdeeParams(next); store.set(TDEEPARAMS_KEY, next); };
  const saveTargetHist = (next) => { setTargetHist(next); store.set(TARGETHIST_KEY, next); };
  // Append a target change (later records win for the same date). kind marks diet-break records so they can be removed with the break.
  const recordTarget = (date, target, kind) => {
    if (target == null) return;
    const next = [...targetHist, { date, target, ...(kind ? { kind } : {}) }].sort((a, b) => a.date.localeCompare(b.date));
    saveTargetHist(next);
  };
  // A new locked target. While a diet break is running the effective target stays at maintenance, so nothing is recorded;
  // ending the break records the locked target.
  const recordLockedTarget = (target) => { if (!dietBreakMode?.active) recordTarget(today, target); };
  const saveDietBreakLog = (next) => { setDietBreakLog(next); store.set(DIETBREAKLOG_KEY, next); };
  const startDietBreak = () => {
    saveDietBreak({ active: true, startDate: today });
    recordTarget(today, maintenanceTarget, "diet_break");
    if (!dietBreakLog.some(b => b.end == null)) saveDietBreakLog([...dietBreakLog, { start: today, end: null }]);
  };
  const endDietBreak = () => {
    saveDietBreak(null);
    recordTarget(today, baseTarget, "diet_break_end");
    saveDietBreakLog(dietBreakLog.map(b => b.end == null ? { ...b, end: today } : b));
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
    const nt = calcTarget(effectiveTDEE, p, m);
    if (nt != null) { saveCycle({ anchorDate: today, lockedTarget: nt, syncedPhaseDate: today }); recordLockedTarget(nt); }
    // Append to phase history (replace same-day record so toggling doesn't spam)
    if (changed) {
      const w = latestWeight;
      const todays = phaseHist.find(h => h.date === today);
      const filtered = phaseHist.filter(h => h.date !== today);
      // Remember the setup from before today's FIRST change, so it can be restored from Stats.
      const prev = todays?.prev ?? { phase, magnitude, cycle };
      savePhaseHist([...filtered, { date: today, phase: p, magnitude: m, weightKg: w ?? null, prev }]);
    }
  };

  // Every phase/intensity change asks first: it resets the target and restarts the review window.
  const requestPhaseChange = (p, m) => {
    if (p === phase && m === magnitude) return; // tapping what is already selected does nothing
    const nt = calcTarget(effectiveTDEE, p, m);
    setDialog({
      title: "Change phase?",
      message: `${phaseLabel(phase, magnitude)} → ${phaseLabel(p, m)}\n`
        + (nt != null ? `Daily target ${baseTarget != null ? baseTarget.toLocaleString() : "—"} → ${nt.toLocaleString()} kcal.\n` : "")
        + "This restarts your 2-week calorie review window. You can undo it afterwards by deleting the record in Stats → Phase History.",
      actions: [
        { label: "Change phase", style: "primary", onClick: () => { setDialog(null); setPhaseAndMag(p, m); } },
        { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
      ],
    });
  };

  const restorePhase = (rec) => {
    const pr = rec.prev;
    setPhase(pr.phase); setMagnitude(pr.magnitude); persistSettings(pr.phase, pr.magnitude);
    if (pr.cycle) {
      saveCycle(pr.cycle);
      // The reverted change (and anything after it) never happened as far as "vs Target" is concerned.
      const kept = targetHist.filter(h => h.date < rec.date);
      const restoredTarget = pr.cycle.lockedTarget;
      const lastKept = kept.length ? kept[kept.length - 1] : null;
      saveTargetHist(restoredTarget != null && lastKept?.target !== restoredTarget
        ? [...kept, { date: rec.date, target: restoredTarget }] : kept);
    }
    savePhaseHist(phaseHist.filter(h => h.date !== rec.date));
    showToast("Previous phase and target restored");
  };
  const requestDeletePhase = (date) => {
    const rec = phaseHist.find(h => h.date === date);
    const removeOnly = () => { setDialog(null); savePhaseHist(phaseHist.filter(h => h.date !== date)); showToast("Phase record removed"); };
    const newest = [...phaseHist].sort((a, b) => b.date.localeCompare(a.date))[0]?.date;
    if (!(rec?.prev && date === newest)) {
      setDialog({
        title: "Delete phase record?",
        message: `Remove the phase change logged on ${date}? This only affects the history log — not your entries or your target.`,
        actions: [
          { label: "Delete", style: "danger", onClick: removeOnly },
          { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
        ],
      });
      return;
    }
    const pt = rec.prev.cycle?.lockedTarget;
    setDialog({
      title: "Delete phase record?",
      message: `Restore your previous setup, or only remove the record?\n\nRestore: back to ${phaseLabel(rec.prev.phase, rec.prev.magnitude)}${pt != null ? ` with a target of ${pt.toLocaleString()} kcal` : ""} and your review window as it was. Any later target changes (a review or TDEE update) are undone.\n\nRemove only: your current phase and target stay as they are.`,
      actions: [
        { label: `Delete & restore${pt != null ? ` (target ${pt.toLocaleString()})` : ""}`, style: "primary", onClick: () => { setDialog(null); restorePhase(rec); } },
        { label: "Delete record only", style: "danger", onClick: removeOnly },
        { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
      ],
    });
  };

  // Save a partial set of fields into the active date (merge, never overwrite siblings)
  // Exclusion state for the active day (non-standard weigh-in = weight AND body fat left out of all calculations)
  const savedExclude = hasFlag(entries[activeDate], FLAGS.NON_STANDARD_WEIGHIN);
  const morningExclude = morningExcludeEdit ?? savedExclude;

  // opts.exclude: undefined = leave the flag alone, true/false = set/clear "non-standard weigh-in"
  const saveFields = async (fields, opts = {}) => {
    const clean = {};
    Object.entries(fields).forEach(([k, v]) => { if (v !== "" && v != null) clean[k] = Number(v); });
    if (!Object.keys(clean).length && opts.exclude === undefined) return false;
    const prev = entries[activeDate] || {};
    const entry = { ...prev, ...clean };
    if (opts.exclude !== undefined || opts.confirm || "weight" in clean) {
      const set = new Set(prev.flags || []);
      if ("weight" in clean) set.delete(FLAGS.WEIGHT_CONFIRMED); // a new reading needs its own confirmation
      if (opts.confirm) set.add(FLAGS.WEIGHT_CONFIRMED);
      if (opts.exclude === true) set.add(FLAGS.NON_STANDARD_WEIGHIN);
      else if (opts.exclude === false) set.delete(FLAGS.NON_STANDARD_WEIGHIN);
      if (set.size) entry.flags = [...set]; else delete entry.flags;
    }
    const next = { ...entries, [activeDate]: entry };
    setEntries(next);
    await persist(next);
    return true;
  };

  const handleSaveMorning = async () => {
    const flagPatch = morningExclude !== savedExclude ? morningExclude : undefined;
    const commit = async (exclude, confirm) => {
      const ok = await saveFields({ weight: morningForm.weight, bf: morningForm.bf }, { exclude, confirm });
      if (ok) { setMorningForm({ weight: "", bf: "" }); setMorningExcludeEdit(null); }
    };
    // Unusual against the recent trend? Offer to exclude it (unless it is already being excluded).
    if (morningForm.weight !== "" && !morningExclude) {
      const odd = checkNewWeight({ date: activeDate, weight: Number(morningForm.weight), entries });
      if (odd) {
        const sign = odd.deviation > 0 ? "+" : "";
        setDialog({
          title: "Unusual weight",
          message: `${sign}${odd.deviation.toFixed(1)} kg from your recent trend (about ${odd.expected.toFixed(1)} kg expected). That is a bigger swing than usual — often water, sodium, or a different scale/time. Exclude it from your trend, TDEE and averages? It stays in your log either way.`,
          actions: [
            { label: "Save & exclude", style: "primary", onClick: async () => { setDialog(null); await commit(true); } },
            { label: "Save anyway", style: "ghost", onClick: async () => { setDialog(null); await commit(flagPatch, true); } },
            { label: "Let me fix it", style: "ghost", onClick: () => setDialog(null) },
          ],
        });
        return;
      }
    }
    await commit(flagPatch);
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
    setMorningExcludeEdit(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const resetToToday = () => {
    setActiveDate(today);
    setMorningExcludeEdit(null);
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
  // Weight/body fat as used by every calculation (non-standard weigh-ins removed). Raw `entries` stays intact.
  const validEntries = buildValidEntries(entries);
  const last7 = sorted.slice(-7).map(d => ({ date: d, ...parseEntry(validEntries[d]) }));

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
  const datedAll = sorted.map(d => ({ date: d, ts: new Date(d + "T00:00:00").getTime(), ...parseEntry(validEntries[d]) }));
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
      const w = validEntries[sorted[i]]?.weight;
      if (w != null) return Number(w);
    }
    return null;
  })();
  const macroWeight = latestWeight ?? avgWeight;

  // Effective TDEE: use measured (regression) when reliable, else Mifflin-St Jeor baseline
  const measuredTDEE = tdee;
  const baselineTDEE = calcBaselineTDEE(profile, macroWeight);
  // Only an approved TDEE feeds targets, macros, diet break and reports. The measured estimate is info only.
  const approvedTDEE = tdeeState?.currentTDEE ?? null;
  const effectiveTDEE = approvedTDEE ?? baselineTDEE;
  const tdeeSource = approvedTDEE != null ? "approved" : (baselineTDEE != null ? "baseline" : null);

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
  const baseTarget = (cycle && cycle.lockedTarget != null) ? cycle.lockedTarget : formulaTarget;
  const maintenanceTarget = effectiveTDEE ? Math.round(effectiveTDEE / 25) * 25 : baseTarget;
  const target = dietBreakMode?.active ? maintenanceTarget : baseTarget;

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
  const sortedTargetHist = [...targetHist].sort((a, b) => a.date.localeCompare(b.date));
  const targetForDate = (dateStr) => {
    // The target that was in force on that date: the latest record on or before it. Days before the first record show nothing.
    let t = null;
    for (const h of sortedTargetHist) { if (h.date <= dateStr) t = h.target; else break; }
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
    const rangeEntries = rangeDates.map(d => ({ date: d, ...parseEntry(validEntries[d]) }));
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
    const startWeight = wRows.length ? wRows[0].weight : null;
    const endWeight = wRows.length ? wRows[wRows.length - 1].weight : null;
    const startBf = bfRows.length ? bfRows[0].bf : null;
    const endBf = bfRows.length ? bfRows[bfRows.length - 1].bf : null;
    const bfChange = (startBf != null && endBf != null) ? endBf - startBf : null;

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
    const wPtsThis = thisWk.filter(d => validEntries[d].weight != null).map(d => ({ x: new Date(d + "T00:00:00").getTime(), y: validEntries[d].weight }));
    let wkWeightChange = null;
    if (wPtsThis.length >= 2) {
      const reg = linReg(wPtsThis);
      if (reg) wkWeightChange = reg.slope * 7 * 86400000; // kg over 7d
    }

    const proteinDays = thisWk.filter(d => entries[d].protein != null);
    const proteinHit = (target != null && macros) ? proteinDays.filter(d => entries[d].protein >= macros.proteinG * 0.9).length : null;

    const calLogged = calsThis.length;
    const wtLogged = thisWk.filter(d => validEntries[d].weight != null).length;

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

  // ── Month comparison data ──
  const now = new Date();
  const thisMonthStart = formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const lastMonthStart = formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastMonthEnd = formatDate(new Date(now.getFullYear(), now.getMonth(), 0));
  const compThis = buildReport(thisMonthStart, today);
  const compLast = buildReport(lastMonthStart, lastMonthEnd);

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

  // First load after this update: approve whatever TDEE the app is showing today so nothing changes,
  // rounded to 5 kcal. New users get the profile baseline. The first review is then 14 days away.
  useEffect(() => {
    if (!loaded || tdeeState != null) return;
    const seed = measuredTDEE ?? baselineTDEE;
    if (seed == null) return; // nothing to approve yet — retry once a weight is logged
    saveTdeeState({
      currentTDEE: roundTo(seed, TDEE_DEFAULTS.roundTo),
      source: measuredTDEE != null ? "migrated" : "baseline",
      lastEventDate: today, lastAcceptDate: null, snoozedUntil: null, largeGapStreak: 0, history: [],
    });
  }, [loaded, tdeeState, measuredTDEE, baselineTDEE]);

  // Existing users: start the target history from the current target (same days that showed "vs Target" before).
  useEffect(() => {
    if (!loaded || targetHist.length > 0) return;
    if (cycle?.lockedTarget != null) saveTargetHist([{ date: cycle.anchorDate ?? today, target: cycle.lockedTarget }]);
  }, [loaded, cycle, targetHist.length]);

  // A diet break already running before the log existed: record its start.
  useEffect(() => {
    if (!loaded) return;
    if (dietBreakMode?.active && !dietBreakLog.some(b => b.end == null)) {
      saveDietBreakLog([...dietBreakLog, { start: dietBreakMode.startDate, end: null }]);
    }
  }, [loaded, dietBreakMode]);

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
    recordLockedTarget(review.proposed);
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

  // ── TDEE review ──
  const tdeeEngine = { cap: tdeeParams.cap, kcalPerKg: tdeeParams.kcalPerKg };
  const tdeeSched = tdeeState ? reviewSchedule({ lastEventDate: tdeeState.lastEventDate, snoozedUntil: tdeeState.snoozedUntil, today }) : null;
  const tdeeDue = tdeeSched?.status === "due";
  const tdeeAssessment = (tdeeState && (tdeeDue || previewTdee))
    ? assessReview({
        entries, today, currentTDEE: tdeeState.currentTDEE, phaseHist, dietBreakLog,
        isFirstReview: !(tdeeState.history || []).some(h => h.decision === "accept"),
        priorLargeGapStreak: tdeeState.largeGapStreak || 0,
        windowFloor: tdeeDue ? tdeeState.lastEventDate : null, // a review never reuses days before the last decision
        params: tdeeEngine,
      })
    : null;
  const tdeeRechecking = tdeeDue && tdeeAssessment?.confidence === "red";
  const reviewAttention = !!review || (tdeeDue && tdeeAssessment != null && tdeeAssessment.confidence !== "red");
  const targetIfAccepted = tdeeAssessment?.proposedTDEE != null ? calcTarget(tdeeAssessment.proposedTDEE, phase, magnitude) : null;

  const updateDayFlags = async (date, patch) => {
    const prev = entries[date] || {};
    const set = new Set(prev.flags || []);
    Object.entries(patch).forEach(([k, v]) => { if (v) set.add(k); else set.delete(k); });
    const entry = { ...prev };
    if (set.size) entry.flags = [...set]; else delete entry.flags;
    const next = { ...entries, [date]: entry };
    setEntries(next);
    await persist(next);
  };

  const acceptTdee = () => {
    if (!tdeeState || !tdeeAssessment?.canAccept) return;
    const nextState = applyDecision(tdeeState, "accept", tdeeAssessment, today);
    saveTdeeState(nextState);
    // A new TDEE re-derives the daily target for the current phase (same formula as a phase change),
    // and restarts the 2-week calorie review so the two reviews never adjust the same period twice.
    const nt = calcTarget(nextState.currentTDEE, phase, magnitude);
    if (nt != null) { saveCycle({ anchorDate: today, lockedTarget: nt, syncedPhaseDate: latestPhaseChangeDate ?? cycle?.syncedPhaseDate ?? today }); recordLockedTarget(nt); }
    setPreviewTdee(false);
    showToast(`TDEE → ${nextState.currentTDEE.toLocaleString()} kcal${nt != null ? ` · target ${nt.toLocaleString()}` : ""}`);
  };
  const removeDietBreak = (idx) => {
    const b = dietBreakLog[idx];
    if (!b || b.end == null) return;
    saveDietBreakLog(dietBreakLog.filter((_, i) => i !== idx));
    saveTargetHist(targetHist.filter(h => !((h.kind === "diet_break" && h.date === b.start) || (h.kind === "diet_break_end" && h.date === b.end))));
    showToast("Diet break removed from history");
  };
  const requestRemoveDietBreak = (idx) => {
    const b = dietBreakLog[idx];
    if (!b || b.end == null) return;
    setDialog({
      title: "Remove this diet break?",
      message: `${b.start} → ${b.end}\nThis only removes it from your history. TDEE reviews stop treating it as a break, and "vs Target" uses your normal target on those days. Your current phase and target don't change.`,
      actions: [
        { label: "Remove", style: "danger", onClick: () => { setDialog(null); removeDietBreak(idx); } },
        { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
      ],
    });
  };
  const confirmAcceptTdee = () => {
    const a = tdeeAssessment;
    if (!a?.canAccept) return;
    setDialog({
      title: "Update your TDEE?",
      message: `TDEE ${a.currentTDEE.toLocaleString()} → ${a.proposedTDEE.toLocaleString()} kcal (${a.proposedChange >= 0 ? "+" : ""}${a.proposedChange}).\n`
        + (targetIfAccepted != null ? `Your daily target is recalculated for your current phase: ${(baseTarget ?? 0).toLocaleString()} → ${targetIfAccepted.toLocaleString()} kcal.\n` : "")
        + "Your 2-week calorie review window restarts today.",
      actions: [
        { label: "Update TDEE", style: "primary", onClick: () => { setDialog(null); acceptTdee(); } },
        { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
      ],
    });
  };
  const keepTdee = () => {
    if (!tdeeState || !tdeeAssessment) return;
    saveTdeeState(applyDecision(tdeeState, "keep", tdeeAssessment, today));
    setPreviewTdee(false);
    showToast("TDEE kept — next review in 14 days");
  };
  const deferTdee = () => {
    if (!tdeeState || !tdeeAssessment) return;
    saveTdeeState(applyDecision(tdeeState, "defer", tdeeAssessment, today));
    showToast("Review snoozed for 7 days");
  };
  const explainTraffic = () => setDialog({
    title: "How reliable is this review?",
    message: "Green — Reliable\nEnough consistent data is available to consider updating your TDEE.\n\n"
      + "Amber — Uncertain\nThere is enough data to estimate TDEE, but some factors make the result less reliable. Keeping your current TDEE for another review may be appropriate.\n\n"
      + "Red — Insufficient data\nThe available data is not reliable enough to change your TDEE yet.",
    actions: [{ label: "Got it", style: "ghost", onClick: () => setDialog(null) }],
  });

  // Clean data but raw TDEE is >500 kcal from current: record it as a kept review so a repeat can unlock the escape route.
  useEffect(() => {
    if (!loaded || !tdeeState || !tdeeAssessment || !tdeeDue) return;
    if (tdeeAssessment.confidence === "red" && tdeeAssessment.gapOnlyRed) {
      saveTdeeState(applyDecision(tdeeState, "auto_keep", tdeeAssessment, today));
      showToast("Review done — your data is reliable but raw TDEE is far from your current TDEE. Kept for now.");
    }
  }, [loaded, tdeeDue, tdeeAssessment?.confidence, tdeeAssessment?.gapOnlyRed]);

  const activeEntry = entries[activeDate] || {};
  const dayHasData = activeEntry.weight != null || activeEntry.bf != null || activeEntry.calories != null || activeEntry.protein != null;
  const isToday = activeDate === today;
  const morningLogged = activeEntry.weight != null || activeEntry.bf != null;
  const morningFlagChanged = morningExclude !== savedExclude;
  const morningDisabled = morningForm.weight === "" && morningForm.bf === "" && !(morningFlagChanged && morningLogged);
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
      const e = parseEntry(validEntries[d]);
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

  const buildCSV = () => entriesToCSV(entries);

  const buildJSON = () => JSON.stringify(
    { exported: new Date().toISOString(), phase, magnitude, tdeeWindow, profile, cycle, goal, phaseHist, tdeeState, dietBreakLog, dietBreakMode, waterLog, tdeeParams, targetHist, entries },
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
        if (parsed.phase || parsed.magnitude || parsed.tdeeWindow || parsed.profile || parsed.cycle || parsed.goal || parsed.phaseHist || parsed.tdeeState || parsed.dietBreakLog || parsed.waterLog || parsed.tdeeParams || parsed.targetHist || parsed.dietBreakMode !== undefined) settings = parsed;
      } catch (_) { showToast("Invalid JSON file"); return; }
    } else {
      imported = csvToEntries(text);
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
        if (settings.tdeeState) saveTdeeState(settings.tdeeState);
        if (Array.isArray(settings.dietBreakLog)) saveDietBreakLog(settings.dietBreakLog);
        if (settings.dietBreakMode !== undefined) saveDietBreak(settings.dietBreakMode);
        if (settings.waterLog) saveWater(settings.waterLog);
        if (Array.isArray(settings.targetHist)) saveTargetHist(settings.targetHist);
        else if (settings.cycle?.lockedTarget != null) saveTargetHist([{ date: settings.cycle.anchorDate ?? today, target: settings.cycle.lockedTarget }]);
        if (settings.tdeeParams) saveTdeeParams({ cap: settings.tdeeParams.cap ?? TDEE_DEFAULTS.cap, kcalPerKg: settings.tdeeParams.kcalPerKg ?? TDEE_DEFAULTS.kcalPerKg });
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
        { label: "Merge", style: "primary", onClick: () => { setDialog(null); applyImport(mergeEntries(entries, imported)); } },
        { label: "Replace all", style: "danger", onClick: () => { setDialog(null); applyImport(imported); } },
        { label: "Cancel", style: "ghost", onClick: () => setDialog(null) },
      ],
    });
  };


  // ── Daily Tracking history: 14 calendar days (empty days get a "Log" button), older entries on request ──
  const logWindowDates = Array.from({ length: 14 }, (_, i) => addDaysStr(today, -i));
  const logWindowStart = logWindowDates[logWindowDates.length - 1];
  const olderLogged = [...sorted].reverse().filter(d => d < logWindowStart);
  const olderShown = olderLogged.slice(0, olderCount);
  // Compact cell padding so the 6 columns fit a phone: 12px on the outer edges, 6px between columns
  const logPad = (col) => col === 0 ? "10px 6px 10px 12px" : col === 5 ? "10px 12px 10px 6px" : "10px 6px";
  const renderLogRow = (date, idx, total) => {
    const raw = entries[date];
    const empty = !raw;
    const e = raw ? parseEntry(raw) : { calories: null, weight: null, bf: null, protein: null };
    const excl = raw ? validReading(raw).excluded : false;
    const isRecent = last7.some(r => r.date === date);
    const rowTarget = raw ? targetForDate(date) : null;
    const rowPhase = phaseOnDate(date).phase;
    let calDiff = null, calColor = "var(--text-muted)";
    if (e.calories != null && rowTarget != null) {
      calDiff = Math.round(e.calories - rowTarget);
      const over = calDiff > 0;
      if (rowPhase === "cut") calColor = over ? "#f87171" : "#34d399";
      else if (rowPhase === "bulk") calColor = over ? "#34d399" : "#f87171";
      else calColor = Math.abs(calDiff) <= 100 ? "#34d399" : "#f87171";
    }
    const flagLabels = FLAG_OPTIONS.filter(f => (raw?.flags || []).includes(f.id)).map(f => f.label);
    const dObj = new Date(date + "T00:00:00");
    const dayMonth = dObj.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const weekday = dObj.toLocaleDateString(undefined, { weekday: "short" });
    const exclStyle = excl ? { textDecoration: "line-through", opacity: 0.5 } : undefined;
    const numCell = (v) => ({ padding: logPad(v), textAlign: "right", fontVariantNumeric: "tabular-nums" });
    return (
      <tr key={date} style={{ borderBottom: idx < total - 1 ? "1px solid var(--surface-2)" : "none", background: activeDate === date && date !== today ? "var(--surface-2)" : "transparent" }}>
        <td title={date} style={{ padding: logPad(0), whiteSpace: "nowrap", color: empty ? "var(--text-dim)" : isRecent ? "var(--text)" : "var(--text-muted)", fontVariantNumeric: "tabular-nums", lineHeight: 1.25 }}>
          <div>{date === today ? "Today" : dayMonth}</div>
          <div style={{ fontSize: 9.5, color: "var(--text-dim)", marginTop: 1 }}>
            {weekday}
            {isRecent && <span title="Counts toward your 7-day averages" style={{ display: "inline-block", width: 5, height: 5, borderRadius: 3, background: "#6366f1", marginLeft: 5, verticalAlign: "middle" }} />}
            {flagLabels.length > 0 && <span title={flagLabels.join(", ")} style={{ marginLeft: 5, fontSize: 10, color: "#fbbf24" }}>⚑</span>}
          </div>
        </td>
        <td style={{ ...numCell(1), color: e.calories != null ? "var(--text)" : "var(--text-faint)" }}>
          {e.calories != null ? e.calories.toLocaleString() : "—"}
        </td>
        <td style={{ ...numCell(2), fontSize: 11 }}>
          {calDiff != null
            ? <span style={{ color: calColor }}>{calDiff > 0 ? "+" : ""}{calDiff}</span>
            : <span style={{ color: "var(--text-faint)" }}>—</span>}
        </td>
        <td style={{ ...numCell(3), color: e.weight != null ? "var(--text)" : "var(--text-faint)" }}>
          {e.weight != null ? <span title={excl ? "Excluded: non-standard weigh-in" : undefined} style={exclStyle}>{e.weight.toFixed(1)}</span> : "—"}
        </td>
        <td style={{ ...numCell(4), color: e.bf != null ? "var(--text)" : "var(--text-faint)" }}>
          {e.bf != null ? <span title={excl ? "Excluded: non-standard weigh-in" : undefined} style={exclStyle}>{`${e.bf.toFixed(1)}%`}</span> : "—"}
        </td>
        <td style={{ padding: logPad(5), textAlign: "right", whiteSpace: "nowrap" }}>
          {empty ? (
            <button onClick={() => handleEdit(date)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-soft)", cursor: "pointer", fontSize: 11, padding: "3px 8px" }}>Log</button>
          ) : (
            <>
              <button onClick={() => handleEdit(date)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}>Edit</button>
              <button onClick={() => handleDelete(date)} aria-label="Delete entry" style={{ background: "none", border: "none", color: "var(--border-strong)", cursor: "pointer", fontSize: 11, padding: "2px 4px" }}>✕</button>
            </>
          )}
        </td>
      </tr>
    );
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
          tdeeParams={tdeeParams}
          onSave={(p, tp) => { saveProfile(p); saveTdeeParams(tp); setProfileOpen(false); showToast("Profile saved"); }}
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
      <div style={{ borderBottom: "1px solid var(--border)", display: "flex", gap: 2, padding: "0 12px", maxWidth: 820, margin: "0 auto", overflowX: "auto", scrollbarWidth: "none" }}>
        {[
          { id: "daily", label: "Daily" },
          { id: "log", label: "Targets" },
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
              padding: "14px 11px 12px", fontSize: 12, fontWeight: 600, flexShrink: 0, whiteSpace: "nowrap",
              letterSpacing: "0.04em", color: view === t.id ? "var(--text)" : "var(--text-dim)",
              borderBottom: `2px solid ${view === t.id ? "#6366f1" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {t.label}
            {t.id === "log" && reviewAttention && <span aria-label="Review ready" style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, background: "#fbbf24", marginLeft: 6, verticalAlign: "middle" }} />}
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
            avgBf={avgBf} profile={profile} kcalPerKg={tdeeParams.kcalPerKg}
          />
        )}
        {view === "stats" && (
          <StatsView
            adherence={adherence} phaseHist={phaseHist}
            weekly={weekly} goalInfo={goalInfo} phase={phase} tdeeHistory={tdeeState?.history || []}
            dietBreakLog={dietBreakLog} dietBreakActive={!!dietBreakMode?.active} onRemoveDietBreak={requestRemoveDietBreak}
            onDeletePhase={requestDeletePhase}
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
            compThis={compThis}
            compLast={compLast}
          />
        )}
        {view === "daily" && (
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
              <label style={{ display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 14, cursor: "pointer", fontSize: 10.5, color: "var(--text-soft)", lineHeight: 1.4 }}>
                <input type="checkbox" checked={morningExclude}
                  disabled={!(activeEntry.weight != null || activeEntry.bf != null || morningForm.weight !== "" || morningForm.bf !== "")}
                  onChange={e => setMorningExcludeEdit(e.target.checked)}
                  style={{ accentColor: "#8b5cf6", width: 14, height: 14, marginTop: 1, flexShrink: 0 }} />
                <span>Non-standard weigh-in — leave weight &amp; body fat out of calculations</span>
              </label>
              <button onClick={handleSaveMorning}
                disabled={morningDisabled}
                style={{
                  width: "100%", background: morningDisabled ? "var(--border)" : "#8b5cf6",
                  color: morningDisabled ? "var(--text-dim)" : "#fff",
                  border: "none", borderRadius: 6, padding: "9px", fontSize: 12, fontWeight: 600,
                  letterSpacing: "0.04em", textTransform: "uppercase",
                  cursor: morningDisabled ? "default" : "pointer",
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

          {/* Anything unusual? (feeds the TDEE review's confidence) */}
          <div style={{ marginTop: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px" }}>
            <button onClick={() => setFlagsOpen(o => !o)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", padding: 0, color: "var(--text-bright)" }}>
              <span style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700 }}>
                Anything unusual today?{(() => { const n = FLAG_OPTIONS.filter(f => (activeEntry.flags || []).includes(f.id)).length; return n ? ` · ${n} selected` : ""; })()}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{flagsOpen ? "▴" : "▾"}</span>
            </button>
            {flagsOpen && (
              <div style={{ marginTop: 12 }}>
                {!dayHasData && <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginBottom: 8 }}>Log a weight or calories for this day first.</div>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {FLAG_OPTIONS.map(f => {
                    const on = (activeEntry.flags || []).includes(f.id);
                    return (
                      <button key={f.id} disabled={!dayHasData} onClick={() => updateDayFlags(activeDate, { [f.id]: !on })}
                        style={{ background: on ? "#6366f126" : "transparent", border: `1px solid ${on ? "#6366f1" : "var(--border)"}`, color: on ? "#a5b4fc" : "var(--text-soft)", borderRadius: 999, padding: "5px 11px", fontSize: 11, fontWeight: 600, cursor: dayHasData ? "pointer" : "default", opacity: dayHasData ? 1 : 0.5 }}>
                        {f.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
                  These make your TDEE review more careful about trusting this period. They never change your phase or calorie target.
                </div>
              </div>
            )}
          </div>
        </div>

        {!isToday && (
          <div style={{ marginTop: 20, fontSize: 10.5, color: "#fbbf24", lineHeight: 1.5 }}>
            Hydration always tracks today, not the date selected above.
          </div>
        )}
        {/* ── Hydration Tracker ── */}
        <WaterLogger
          date={today}
          waterLog={waterLog}
          latestWeight={latestWeight}
          addWaterAmount={addWaterAmount}
          toggleGymDay={toggleGymDay}
          undoLastWater={undoLastWater}
        />

        {/* ── Last 14 days ── */}
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Last 14 days</div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Date", "Kcal", "vs Target", "Kg", "BF%", ""].map((h, i) => (
                    <th key={i} style={{ padding: logPad(i), textAlign: i === 0 ? "left" : "right", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, background: "var(--surface)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logWindowDates.map((d, i) => renderLogRow(d, i, logWindowDates.length + olderShown.length))}
                {olderShown.map((d, i) => renderLogRow(d, logWindowDates.length + i, logWindowDates.length + olderShown.length))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, fontSize: 10, color: "var(--text-dim)" }}>
            "vs Target" uses the calorie target that was active on each date, based on your Phase History — not today's target.
          </div>
          {[...logWindowDates, ...olderShown].some(dt => entries[dt] && validReading(entries[dt]).excluded) && (
            <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)" }}>
              Struck-through weight and body fat are marked non-standard and left out of all calculations.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {olderLogged.length > olderShown.length && (
              <button onClick={() => setOlderCount(c => c + 30)}
                style={{ background: "transparent", color: "var(--text-soft)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                Show older entries ({olderLogged.length - olderShown.length} more)
              </button>
            )}
            {olderShown.length > 0 && (
              <button onClick={() => setOlderCount(0)}
                style={{ background: "transparent", color: "var(--text-muted)", border: "none", padding: "7px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                Hide older
              </button>
            )}
          </div>
        </div>

        {sorted.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "var(--border-strong)" }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 12, letterSpacing: "0.05em" }}>No entries yet. Log your first day above.</div>
          </div>
        )}
        </>
        )}
        {view === "log" && (
        <>

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
            <button onClick={() => requestPhaseChange("maintain", "maintain")}
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
                onClick={() => requestPhaseChange(rec.phase, rec.magnitude)}
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
                    if (key !== phase) requestPhaseChange(key, defaultMag);
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
                    onClick={() => requestPhaseChange(phase, mag.id)}
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

          {/* Approved TDEE — the value targets, macros and diet break use */}
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 16px", marginBottom: 14 }}>
            <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 8 }}>Approved TDEE</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: "#34d399", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em" }}>
                {effectiveTDEE != null ? effectiveTDEE.toLocaleString() : "—"}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>kcal/day</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 6 }}>
                {tdeeState?.source === "migrated" ? "carried over from your measured estimate" : tdeeState?.source === "accepted" ? "approved by you" : "baseline estimate (Mifflin-St Jeor)"}
              </span>
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}>
              Used for phase targets, macros and diet break. It only changes when you approve an update.
            </div>
          </div>

          {/* TDEE review: countdown, preview and the review itself */}
          {tdeeState && tdeeSched && (
            <TdeeReviewSection
              state={tdeeState} schedule={tdeeSched} assessment={tdeeAssessment}
              due={tdeeDue} recheck={tdeeRechecking}
              preview={previewTdee} setPreview={setPreviewTdee}
              targetNow={baseTarget} targetIfAccepted={targetIfAccepted}
              onAccept={confirmAcceptTdee} onKeep={keepTdee} onDefer={deferTdee}
              onExplain={explainTraffic}
              onReviewNow={() => saveTdeeState({ ...tdeeState, snoozedUntil: null })}
              onWeightExclude={(d) => updateDayFlags(d, { [FLAGS.NON_STANDARD_WEIGHIN]: true })}
              onWeightConfirm={(d) => updateDayFlags(d, { [FLAGS.WEIGHT_CONFIRMED]: true })}
            />
          )}

          {/* Target calorie card */}
          {target != null && (
            <div style={{
              background: phaseInfo.color + "1a",
              border: `1px solid ${phaseInfo.color}40`,
              borderRadius: 8, padding: "14px 16px",
              display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10,
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
                  {tdeeSource === "baseline" && "Baseline estimate (Mifflin-St Jeor). "}
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
              Log a bodyweight to generate a starting target from your profile. A TDEE review opens after 14 days of data.
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


        {/* ── Diet Break / Deload ── */}
        <div style={{ marginBottom: 24 }}>
          {dietBreakMode?.active ? (
            <div style={{ background: "#34d39912", border: "1px solid #34d39940", borderRadius: 10, padding: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#34d399" }}>
                  🌿 Diet break / deload — Day {Math.floor((new Date(today + "T00:00:00") - new Date(dietBreakMode.startDate + "T00:00:00")) / 86400000) + 1}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{maintenanceTarget?.toLocaleString()} kcal</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--text-soft)", lineHeight: 1.5, marginBottom: 10 }}>
                Target set to maintenance. Eat at maintenance, reduce training intensity — hormones stabilise over 1–2 weeks.
              </div>
              <button onClick={endDietBreak}
                style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                End diet break
              </button>
            </div>
          ) : (
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "10px 0" }}>
              <input type="checkbox" onChange={e => { if (e.target.checked) startDietBreak(); }}
                style={{ accentColor: "#34d399", width: 15, height: 15 }} />
              <span style={{ fontSize: 12, color: "var(--text-soft)" }}>
                Deload / diet break — switch to maintenance calories
              </span>
            </label>
          )}
        </div>

        </>
        )}
      </div>
    </div>
  );
}

// ── Hydration Tracker ──
function WaterLogger({ date, waterLog, latestWeight, addWaterAmount, toggleGymDay, undoLastWater }) {
  const [customMl, setCustomMl] = useState("");
  const [carbMl, setCarbMl] = useState("");
  const [carbG, setCarbG] = useState("");

  const day = waterLog[date] || { plain: 0, carbMix: 0, gymDay: false };
  const plain = day.plain || 0;
  const carb = day.carbMix || 0;
  const total = plain + carb;

  // Goal: 35ml/kg base + 750ml on gym days
  const baseGoal = latestWeight ? Math.round((latestWeight * 35) / 100) * 100 : 2500;
  const goal = baseGoal + (day.gymDay ? 750 : 0);
  const pct = Math.min(100, Math.round((total / goal) * 100));
  const gaugeColor = pct >= 100 ? "#34d399" : pct >= 66 ? "#60a5fa" : pct >= 33 ? "#818cf8" : "var(--border-strong)";

  // Maltodextrin concentration warning: 8% max = 80g per litre
  const maxMaltodextrin = carbMl !== "" ? Math.floor(Number(carbMl) * 0.08) : null;
  const carbGNum = carbG !== "" ? Number(carbG) : null;
  const concPct = carbMl !== "" && carbGNum != null ? (carbGNum / Number(carbMl)) * 100 : null;
  const concWarning = concPct != null && concPct > 8
    ? `Too concentrated (${concPct.toFixed(1)}%) — above 8% slows absorption. Max ${maxMaltodextrin}g for ${carbMl}ml.`
    : concPct != null && concPct >= 6
    ? `Good concentration (${concPct.toFixed(1)}%) — within 6–8% window ✓`
    : concPct != null
    ? `Dilute (${concPct.toFixed(1)}%) — fine for hydration, low carb delivery`
    : null;
  const concColor = concPct != null && concPct > 8 ? "#f87171" : concPct != null && concPct >= 6 ? "#34d399" : "var(--text-muted)";

  const field = { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 10px", color: "var(--text)", fontSize: 12, outline: "none", boxSizing: "border-box" };
  const presetBtn = { border: "1px solid var(--border)", borderRadius: 6, padding: "5px 9px", fontSize: 11, fontWeight: 600, cursor: "pointer", background: "var(--bg)", color: "var(--text-soft)" };

  return (
    <div style={{ marginTop: 24, marginBottom: 28 }}>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 10 }}>Hydration</div>
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px" }}>
        {/* Goal + gym day */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
            Goal: <strong style={{ color: "var(--text)" }}>{(goal / 1000).toFixed(1)}L</strong>
            <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>({(baseGoal / 1000).toFixed(1)}L base{day.gymDay ? " + 0.75L gym" : ""})</span>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11, color: "var(--text-soft)" }}>
            <input type="checkbox" checked={day.gymDay} onChange={e => toggleGymDay(date, e.target.checked)}
              style={{ accentColor: "#6366f1", width: 13, height: 13 }} />
            Gym day
          </label>
        </div>
        {/* Gauge */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 5 }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: pct >= 100 ? "#34d399" : "var(--text)", lineHeight: 1 }}>
              {(total / 1000).toFixed(2)}L
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{pct}% of goal</span>
          </div>
          <div style={{ height: 10, borderRadius: 999, background: "var(--bg)", overflow: "hidden", border: "1px solid var(--border)" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: gaugeColor, borderRadius: 999, transition: "width 300ms ease" }} />
          </div>
          {pct >= 100 && <div style={{ fontSize: 10, color: "#34d399", marginTop: 4, textAlign: "center" }}>✓ Goal reached</div>}
          {(plain > 0 || carb > 0) && (
            <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
              {plain > 0 && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>💧 Water: <strong style={{ color: "var(--text)" }}>{(plain / 1000).toFixed(2)}L</strong></span>}
              {carb > 0 && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>🟡 Carb mix: <strong style={{ color: "#f59e0b" }}>{(carb / 1000).toFixed(2)}L</strong></span>}
            </div>
          )}
        </div>
        {/* Water presets */}
        <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>Add water</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {[150, 250, 330, 500, 750].map(ml => (
            <button key={ml} onClick={() => addWaterAmount(date, "plain", ml)} style={presetBtn}>{ml}ml</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <input type="number" inputMode="decimal" value={customMl} onChange={e => setCustomMl(e.target.value)}
            placeholder="Custom ml" style={{ ...field, flex: 1 }} />
          <button onClick={() => { if (customMl !== "") { addWaterAmount(date, "plain", Number(customMl)); setCustomMl(""); } }}
            style={{ ...presetBtn, background: "#6366f1", color: "#fff", border: "none", padding: "7px 14px" }}>Add</button>
        </div>
        {/* Carb mix section */}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div style={{ fontSize: 9, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>
            Carb mix (maltodextrin + water)
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8, lineHeight: 1.5 }}>
            Mix at 6–8% for full hydration credit. Counts toward your daily goal when correctly diluted.
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: "var(--text-muted)", marginBottom: 3 }}>Volume (ml)</div>
              <input type="number" inputMode="decimal" value={carbMl} onChange={e => setCarbMl(e.target.value)}
                placeholder="e.g. 500" style={{ ...field, width: "100%" }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 9, color: "var(--text-muted)", marginBottom: 3 }}>
                Maltodextrin (g) {carbMl !== "" ? `· max ${Math.floor(Number(carbMl) * 0.08)}g` : ""}
              </div>
              <input type="number" inputMode="decimal" value={carbG} onChange={e => setCarbG(e.target.value)}
                placeholder="e.g. 35" style={{ ...field, width: "100%", borderColor: concPct != null && concPct > 8 ? "#f87171" : "var(--border)" }} />
            </div>
          </div>
          {concWarning && (
            <div style={{ fontSize: 10, color: concColor, marginBottom: 8, lineHeight: 1.4 }}>{concWarning}</div>
          )}
          <button
            disabled={carbMl === "" || (concPct != null && concPct > 8)}
            onClick={() => {
              if (carbMl !== "" && (concPct == null || concPct <= 8)) {
                addWaterAmount(date, "carbMix", Number(carbMl));
                setCarbMl(""); setCarbG("");
              }
            }}
            style={{ ...presetBtn, background: (carbMl === "" || (concPct != null && concPct > 8)) ? "var(--border)" : "#f59e0b", color: (carbMl === "" || (concPct != null && concPct > 8)) ? "var(--text-dim)" : "#fff", border: "none", padding: "7px 16px", cursor: (carbMl === "" || (concPct != null && concPct > 8)) ? "default" : "pointer" }}>
            Log carb mix
          </button>
          {carb > 0 && (
            <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 10 }}>
              Today: {(carb / 1000).toFixed(2)}L logged
            </span>
          )}
        </div>
        {/* Undo last entry */}
        {day.lastAction && (
          <button onClick={() => undoLastWater(date)} style={{ marginTop: 12, background: "none", border: "none", color: "var(--text-muted)", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            ↩ Undo last ({day.lastAction.field === "plain" ? "water" : "carb mix"} {day.lastAction.amount}ml)
          </button>
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

function MacrosView({ macros, target, tdee, phase, phaseInfo, magInfo, magnitude, macroWeight, sortedLen, avgBf, profile, kcalPerKg = KCAL_PER_KG }) {
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
  const impliedRate = ((activeCals - tdee) / kcalPerKg) * 7; // kg/week
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

function ProfileModal({ profile, age, baselineTDEE, tdeeParams, onSave, onClose }) {
  const [capIn, setCapIn] = useState(String(tdeeParams?.cap ?? 100));
  const [kcalIn, setKcalIn] = useState(String(tdeeParams?.kcalPerKg ?? 7700));
  const [dob, setDob] = useState(profile.dob || "");
  const [ft, setFt] = useState(profile.heightCm ? Math.floor(profile.heightCm / 30.48) : "");
  const [inch, setInch] = useState(profile.heightCm ? Math.round((profile.heightCm / 2.54) % 12) : "");
  const [sex, setSex] = useState(profile.sex || "male");
  const [activity, setActivity] = useState(profile.activity || 1.55);

  const heightCm = ft !== "" ? (Number(ft) * 30.48 + Number(inch || 0) * 2.54) : profile.heightCm;
  const liveAge = ageFromDOB(dob);

  const handleSave = () => {
    const cap = Math.min(150, Math.max(50, Math.round((Number(capIn) || 100) / 5) * 5));
    const kcalPerKg = Math.min(8000, Math.max(7000, Math.round(Number(kcalIn) || 7700)));
    onSave({ dob, heightCm: Math.round(heightCm * 10) / 10, sex, activity: Number(activity) }, { cap, kcalPerKg });
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

        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>TDEE review</label>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>Max change per review (kcal, 50–150)</div>
              <input type="number" value={capIn} min={50} max={150} step={5} onChange={e => setCapIn(e.target.value)} style={field} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>kcal per kg of body weight</div>
              <input type="number" value={kcalIn} min={7000} max={8000} step={50} onChange={e => setKcalIn(e.target.value)} style={field} />
            </div>
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

function StatsView({ adherence, phaseHist, onDeletePhase, onEditPhaseDate, weekly, goalInfo, phase, tdeeHistory = [], dietBreakLog = [], dietBreakActive = false, onRemoveDietBreak }) {
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

      {/* TDEE reviews */}
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>TDEE Reviews</div>
      {tdeeHistory.length > 0 ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 24 }}>
          {[...tdeeHistory].reverse().map((h, i, arr) => (
            <div key={h.date + i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: i < arr.length - 1 ? "1px solid var(--surface-2)" : "none" }}>
              <div style={{ width: 8, height: 8, borderRadius: 4, background: (CONF_META[h.confidence] || {}).color || "var(--text-muted)", flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{h.date} · {DECISION_LABEL[h.decision] || h.decision}</div>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                  raw {h.raw != null ? h.raw.toLocaleString() : "—"} · TDEE {h.previous != null ? h.previous.toLocaleString() : "—"} → {h.applied != null ? h.applied.toLocaleString() : "—"}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 8, padding: "28px 0", textAlign: "center", color: "var(--border-strong)", fontSize: 12, marginBottom: 24 }}>
          Completed TDEE reviews will be listed here.
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

      {/* Diet breaks */}
      <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, margin: "24px 0 12px" }}>Diet Breaks</div>
      {dietBreakLog.length > 0 ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {dietBreakLog.map((b, i) => ({ b, i })).reverse().map(({ b, i }, k, arr) => {
            const active = b.end == null;
            const days = Math.max(1, dayNum(active ? formatDate(new Date()) : b.end) - dayNum(b.start) + 1);
            return (
              <div key={b.start + i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: k < arr.length - 1 ? "1px solid var(--surface-2)" : "none" }}>
                <div style={{ width: 8, height: 8, borderRadius: 4, background: "#34d399", flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#34d399" }}>{active ? "Active now" : "Diet break / deload"}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                    {active ? `since ${b.start}` : `${b.start} → ${b.end}`} · {days} day{days === 1 ? "" : "s"}
                  </div>
                </div>
                {!active && (
                  <button onClick={() => onRemoveDietBreak(i)} aria-label="Remove diet break" style={{ background: "none", border: "none", color: "var(--border-strong)", cursor: "pointer", fontSize: 12 }}>✕</button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 8, padding: "28px 0", textAlign: "center", color: "var(--border-strong)", fontSize: 12 }}>
          Diet breaks and deloads will be listed here.
        </div>
      )}
    </div>
  );
}

// ── TDEE review (inside the TDEE card area) ──
const CONF_META = {
  green: { label: "Green — Reliable", color: "#34d399" },
  amber: { label: "Amber — Uncertain", color: "#fbbf24" },
  red: { label: "Red — Insufficient data", color: "#f87171" },
};
const DECISION_LABEL = { accept: "Accepted", keep: "Kept current", auto_keep: "Kept (automatic)" };

function TdeeReviewSection({ state, schedule, assessment, due, recheck, preview, setPreview, targetNow, targetIfAccepted, onAccept, onKeep, onDefer, onExplain, onReviewNow, onWeightExclude, onWeightConfirm }) {
  const fmtD = (s) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const a = assessment;
  const showPanel = a != null && (due || preview);
  const actionable = due && !preview && a != null;
  const last = (state.history || []).length ? state.history[state.history.length - 1] : null;
  const meta = a ? CONF_META[a.confidence] : null;
  const pending = a ? a.suspectWeights.length : 0;
  const ghost = { background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-soft)", borderRadius: 6, padding: "7px 14px", fontSize: 11, fontWeight: 600, cursor: "pointer" };
  const fill = (c) => ({ background: c, border: "none", color: "#06121f", borderRadius: 6, padding: "7px 14px", fontSize: 11, fontWeight: 700, cursor: "pointer" });
  const cell = (label, value, sub, color) => (
    <div style={{ background: "var(--bg)", borderRadius: 8, padding: "9px 11px" }}>
      <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color || "var(--text)", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  let status;
  if (schedule.status === "countdown") status = `Next review in ${schedule.daysLeft} day${schedule.daysLeft === 1 ? "" : "s"} · ${fmtD(schedule.dueDate)}`;
  else if (schedule.status === "snoozed") status = `Review snoozed until ${fmtD(schedule.until)}`;
  else if (recheck) status = "Re-checking daily — your data isn't reliable enough yet";
  else status = "Review due now";

  return (
    <div style={{ background: "var(--surface)", border: `1px solid ${showPanel && meta ? meta.color + "55" : "var(--border)"}`, borderRadius: 8, padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 5 }}>TDEE review</div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: due ? "#fbbf24" : "var(--text)" }}>{status}</div>
          {last && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>
              Last review {fmtD(last.date)}: {last.confidence} · {DECISION_LABEL[last.decision] || last.decision}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {schedule.status === "snoozed" && <button onClick={onReviewNow} style={ghost}>Review now</button>}
          {!due && !preview && <button onClick={() => setPreview(true)} style={ghost}>Preview review</button>}
          {!due && preview && <button onClick={() => setPreview(false)} style={ghost}>Close preview</button>}
        </div>
      </div>

      {showPanel && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ width: 9, height: 9, borderRadius: 5, background: meta.color }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: meta.color }}>{meta.label}</span>
            <button onClick={onExplain} aria-label="What do Green, Amber and Red mean?" style={{ background: "none", border: "1px solid var(--border-strong)", color: "var(--text-muted)", borderRadius: 999, width: 18, height: 18, fontSize: 10, fontWeight: 700, cursor: "pointer", lineHeight: 1, padding: 0 }}>i</button>
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 12 }}>
            {fmtD(a.window.start)} – {fmtD(a.window.end)}{!due ? " · preview only" : ""}
          </div>

          {pending > 0 && (
            <div style={{ background: "#fbbf2412", border: "1px solid #fbbf2440", borderRadius: 8, padding: "10px 12px", marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#fbbf24", marginBottom: 6 }}>Check {pending === 1 ? "this weigh-in" : "these weigh-ins"} first</div>
              {a.suspectWeights.map(s => (
                <div key={s.date} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", padding: "5px 0" }}>
                  <span style={{ fontSize: 11, color: "var(--text-soft)" }}>
                    {fmtD(s.date)} · <strong style={{ color: "var(--text)" }}>{s.weight.toFixed(1)} kg</strong> vs ~{s.expected.toFixed(1)} expected
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => onWeightExclude(s.date)} style={{ ...ghost, padding: "4px 10px", fontSize: 10.5 }}>Exclude</button>
                    <button onClick={() => onWeightConfirm(s.date)} style={{ ...ghost, padding: "4px 10px", fontSize: 10.5 }}>It's normal</button>
                  </span>
                </div>
              ))}
              {actionable && <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>Accepting is disabled until each one is answered.</div>}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
            {cell("Complete calorie days", `${a.counts.completeDays}/14`)}
            {cell("Valid weigh-ins", `${a.counts.validWeighIns}`, a.counts.excludedWeighIns ? `${a.counts.excludedWeighIns} excluded` : null)}
            {cell("Avg calories", a.avgCalories != null ? Math.round(a.avgCalories).toLocaleString() : "—", "complete days only")}
            {cell("Weight trend", a.trend.weeklyRate != null ? `${a.trend.weeklyRate >= 0 ? "+" : ""}${a.trend.weeklyRate.toFixed(2)} kg/wk` : "—")}
            {cell("Raw TDEE", a.rawTDEE != null ? Math.round(a.rawTDEE).toLocaleString() : "—", a.gap != null ? `${a.gap >= 0 ? "+" : ""}${Math.round(a.gap)} vs current` : null)}
            {cell("Current TDEE", a.currentTDEE != null ? a.currentTDEE.toLocaleString() : "—")}
            {cell("Proposed TDEE", a.proposedTDEE != null ? a.proposedTDEE.toLocaleString() : "—",
              a.proposedChange != null ? `${a.proposedChange >= 0 ? "+" : ""}${a.proposedChange} kcal${a.capped ? " (capped)" : ""}` : null, meta.color)}
          </div>

          <div style={{ marginBottom: 12 }}>
            {a.reasons.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--text-soft)" }}>No concerns found in this period.</div>
            ) : a.reasons.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--text-soft)", lineHeight: 1.5, padding: "2px 0" }}>
                <span style={{ color: r.level === "red" ? "#f87171" : "#fbbf24" }}>●</span><span>{r.text}</span>
              </div>
            ))}
            {a.isFirstReview && !a.escapeRoute && (
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>First review: a larger step is allowed (50% of the gap, up to ±150 kcal).</div>
            )}
          </div>

          {a.canAccept && targetNow != null && targetIfAccepted != null && (
            <div style={{ fontSize: 10.5, color: "var(--text-soft)", lineHeight: 1.5, marginBottom: 12 }}>
              If you accept, your daily target is recalculated for your current phase: <strong style={{ color: "var(--text)" }}>{targetNow.toLocaleString()} → {targetIfAccepted.toLocaleString()} kcal</strong>, and your calorie review window restarts today.
            </div>
          )}

          {actionable && a.canAccept && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={onAccept} disabled={pending > 0}
                style={a.confidence === "green" ? { ...fill("#34d399"), opacity: pending > 0 ? 0.4 : 1, cursor: pending > 0 ? "default" : "pointer" } : { ...ghost, opacity: pending > 0 ? 0.4 : 1, cursor: pending > 0 ? "default" : "pointer" }}>
                Accept {a.proposedTDEE.toLocaleString()}
              </button>
              <button onClick={onKeep} style={a.confidence === "amber" ? fill("#fbbf24") : ghost}>Keep current</button>
              <button onClick={onDefer} style={ghost}>Defer 7 days</button>
            </div>
          )}
          {actionable && !a.canAccept && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
              No change is recommended. Your TDEE stays as it is, and this re-checks every day until your recent data is reliable.
            </div>
          )}
          {!due && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
              This is a preview of your last 14 days. You can act on a review from {fmtD(schedule.dueDate)}.
            </div>
          )}
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
        {message && <div style={{ fontSize: 12.5, color: "var(--text-soft)", lineHeight: 1.55, marginBottom: 18, whiteSpace: "pre-line" }}>{message}</div>}
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

function ReportView({ reportRange, setReportRange, reportCustomStart, setReportCustomStart, reportCustomEnd, setReportCustomEnd, reportData, onExportMD, onCopyMD, onExportPDF, compThis, compLast }) {
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
      {/* ── Month Comparison ── */}
      {compThis && compLast && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-dim)", fontWeight: 600, marginBottom: 12 }}>Month Comparison</div>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
            {/* Header */}
            <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr", background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "8px 12px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)" }}>Metric</div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-dim)", textAlign: "center" }}>
                {new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleString("default", { month: "short" })}
              </div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#a5b4fc", textAlign: "center" }}>
                {new Date().toLocaleString("default", { month: "short" })} (so far)
              </div>
            </div>
            {[
              {
                label: "Weight change",
                lastVal: compLast.startWeight != null && compLast.endWeight != null ? `${(compLast.endWeight - compLast.startWeight) >= 0 ? "+" : ""}${(compLast.endWeight - compLast.startWeight).toFixed(1)} kg` : "—",
                currVal: compThis.startWeight != null && compThis.endWeight != null ? `${(compThis.endWeight - compThis.startWeight) >= 0 ? "+" : ""}${(compThis.endWeight - compThis.startWeight).toFixed(1)} kg` : "—",
              },
              {
                label: "BF% change",
                lastVal: compLast.bfChange != null ? `${compLast.bfChange >= 0 ? "+" : ""}${compLast.bfChange.toFixed(1)} pts` : "—",
                currVal: compThis.bfChange != null ? `${compThis.bfChange >= 0 ? "+" : ""}${compThis.bfChange.toFixed(1)} pts` : "—",
              },
              {
                label: "Avg calories",
                lastVal: compLast.avgCalories != null ? `${Math.round(compLast.avgCalories).toLocaleString()} kcal` : "—",
                currVal: compThis.avgCalories != null ? `${Math.round(compThis.avgCalories).toLocaleString()} kcal` : "—",
              },
              {
                label: "Avg protein",
                lastVal: compLast.avgProtein != null ? `${Math.round(compLast.avgProtein)} g` : "—",
                currVal: compThis.avgProtein != null ? `${Math.round(compThis.avgProtein)} g` : "—",
              },
              {
                label: "Calorie adherence",
                lastVal: compLast.targetComparable > 0 ? `${Math.round((compLast.onTargetDays / compLast.targetComparable) * 100)}%` : "—",
                currVal: compThis.targetComparable > 0 ? `${Math.round((compThis.onTargetDays / compThis.targetComparable) * 100)}%` : "—",
              },
              {
                label: "Protein target hit",
                lastVal: compLast.proteinTracked > 0 ? `${Math.round((compLast.proteinHitDays / compLast.proteinTracked) * 100)}%` : "—",
                currVal: compThis.proteinTracked > 0 ? `${Math.round((compThis.proteinHitDays / compThis.proteinTracked) * 100)}%` : "—",
              },
              {
                label: "Days logged",
                lastVal: compLast.entryCount != null ? `${compLast.entryCount}` : "—",
                currVal: compThis.entryCount != null ? `${compThis.entryCount}` : "—",
              },
            ].map((row, idx) => (
              <div key={idx} style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, color: "var(--text-soft)" }}>{row.label}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textAlign: "center" }}>{row.lastVal}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#a5b4fc", textAlign: "center" }}>{row.currVal}</div>
              </div>
            ))}
          </div>
        </div>
      )}

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
