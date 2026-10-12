"use strict";

const DURATION_MS = 30 * 60 * 1000;
const KEY_LOGS = "m30.logs";
const KEY_CURRENT = "m30.current";
const $ = (id) => document.getElementById(id);

// ---- storage ----
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
const getLogs = () => load(KEY_LOGS, []);
const setLogs = (l) => save(KEY_LOGS, l);

// current: { task, goal, startedAt, endsAt, finishedAt?, aborted? } | null
let current = load(KEY_CURRENT, null);
let rating = 0;
let tick = null;

// ---- helpers ----
const pad = (n) => String(n).padStart(2, "0");
function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.3, 0.6].forEach((t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.2, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.25);
    });
  } catch { /* ignore */ }
}

// ---- views ----
function showView(name) {
  $("view-timer").hidden = name !== "timer";
  $("view-log").hidden = name !== "log";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "log") renderLog();
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

function render() {
  const phase = !current ? "setup" : current.finishedAt ? "rating" : "running";
  $("setup").hidden = phase !== "setup";
  $("running").hidden = phase !== "running";
  $("rating").hidden = phase !== "rating";
  clearInterval(tick);
  document.title = "30mm 30分タイマー";
  if (phase === "running") {
    $("r-task").textContent = current.task;
    $("r-goal").textContent = current.goal;
    update();
    tick = setInterval(update, 250);
  } else if (phase === "rating") {
    $("rt-title").textContent = current.aborted ? "中断しました" : "30分おつかれさま!";
    $("e-task").textContent = current.task;
    $("e-goal").textContent = current.goal;
    rating = 0;
    $("note").value = "";
    $("save").disabled = true;
    document.querySelectorAll("#stars button").forEach((b) => b.classList.remove("on"));
  }
}

function update() {
  const left = current.endsAt - Date.now();
  if (left <= 0) return finish(false);
  $("clock").textContent = fmt(left);
  $("bar-fill").style.width = `${((DURATION_MS - left) / DURATION_MS) * 100}%`;
  document.title = `${fmt(left)} ・ ${current.task}`;
}

function finish(aborted) {
  current.finishedAt = aborted ? Date.now() : current.endsAt;
  current.aborted = aborted;
  save(KEY_CURRENT, current);
  if (!aborted) {
    beep();
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("30分経過", { body: `目標: ${current.goal}\n達成度を記録しましょう` });
      }
    } catch { /* ignore */ }
  }
  render();
}

// ---- timer actions ----
$("setup").addEventListener("submit", (e) => {
  e.preventDefault();
  const task = $("task").value.trim(), goal = $("goal").value.trim();
  if (!task || !goal) return;
  const now = Date.now();
  current = { task, goal, startedAt: now, endsAt: now + DURATION_MS };
  save(KEY_CURRENT, current);
  $("task").value = ""; $("goal").value = "";
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch { /* ignore */ }
  render();
});

$("abort").addEventListener("click", () => {
  if (confirm("中断して、ここまでの達成度を記録しますか?")) finish(true);
});

$("stars").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  rating = Number(b.dataset.v);
  document.querySelectorAll("#stars button").forEach((x) => x.classList.toggle("on", Number(x.dataset.v) <= rating));
  $("save").disabled = false;
});

$("rating").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!rating) return;
  const logs = getLogs();
  logs.push({
    id: String(current.startedAt),
    task: current.task,
    goal: current.goal,
    startedAt: current.startedAt,
    finishedAt: current.finishedAt,
    minutes: Math.round((current.finishedAt - current.startedAt) / 60000),
    aborted: !!current.aborted,
    rating,
    note: $("note").value.trim(),
  });
  setLogs(logs);
  current = null;
  try { localStorage.removeItem(KEY_CURRENT); } catch { /* ignore */ }
  render();
  $("day").value = dateKey(Date.now());
  showView("log");
});

// ---- log view ----
function renderLog() {
  const day = $("day").value || dateKey(Date.now());
  $("day").value = day;
  const items = getLogs().filter((l) => dateKey(l.startedAt) === day).sort((a, b) => a.startedAt - b.startedAt);
  const mins = items.reduce((s, l) => s + l.minutes, 0);
  const avg = items.length ? (items.reduce((s, l) => s + l.rating, 0) / items.length).toFixed(1) : "-";
  $("summary").innerHTML = "";
  [[items.length, "セッション"], [mins, "合計(分)"], [avg, "平均達成度"]].forEach(([v, k]) => {
    const d = document.createElement("div");
    const b = document.createElement("b"); b.textContent = v;
    const s = document.createElement("span"); s.textContent = k;
    d.append(b, s);
    $("summary").append(d);
  });
  $("empty").hidden = items.length > 0;
  const ol = $("entries");
  ol.innerHTML = "";
  items.forEach((l) => {
    const li = document.createElement("li");
    const mk = (cls, text) => { const el = document.createElement("div"); el.className = cls; el.textContent = text; return el; };
    li.append(mk("time", `${hhmm(l.startedAt)}–${hhmm(l.finishedAt)}(${l.minutes}分${l.aborted ? "・中断" : ""})`));
    li.append(mk("t", l.task));
    li.append(mk("g", `目標: ${l.goal}`));
    if (l.note) li.append(mk("n", `メモ: ${l.note}`));
    const score = mk("score", String(l.rating));
    const small = document.createElement("small"); small.textContent = " /5";
    score.append(small);
    li.append(score);
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "削除";
    del.addEventListener("click", () => {
      if (!confirm("この記録を削除しますか?")) return;
      setLogs(getLogs().filter((x) => x.id !== l.id));
      renderLog();
    });
    li.append(del);
    ol.append(li);
  });
}

function shiftDay(n) {
  const [y, m, d] = $("day").value.split("-").map(Number);
  $("day").value = dateKey(new Date(y, m - 1, d + n).getTime());
  renderLog();
}
$("prev").addEventListener("click", () => shiftDay(-1));
$("next").addEventListener("click", () => shiftDay(1));
$("today").addEventListener("click", () => { $("day").value = dateKey(Date.now()); renderLog(); });
$("day").addEventListener("change", renderLog);

$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(getLogs(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `30mm-log-${dateKey(Date.now())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// タブが非アクティブでもタイマーが正確になるよう、復帰時に再判定
document.addEventListener("visibilitychange", () => { if (!document.hidden && current && !current.finishedAt) update(); });

$("day").value = dateKey(Date.now());
render();
