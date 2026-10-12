"use strict";

const DURATION_MS = 30 * 60 * 1000;
const KEY_LOGS = "m30.logs";
const KEY_CURRENT = "m30.current";
const KEY_TASKS = "m30.tasks";
const KEY_DISMISSED = "m30.resumeDismissed";
const MAX_TASKS = 30;
let pipWin = null; // 小窓(Document Picture-in-Picture)のウィンドウ
// 時計などを小窓へ移動している間も同じ id で取れるようにする
const $ = (id) => document.getElementById(id) || (pipWin && pipWin.document.getElementById(id));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- storage ----
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
const getLogs = () => load(KEY_LOGS, []);
const setLogs = (l) => save(KEY_LOGS, l);

// 入力済みの「やること」候補(新しい順)。初回は既存ログから作る
function getTasks() {
  const saved = load(KEY_TASKS, null);
  if (saved) return saved;
  const fromLogs = [];
  getLogs().slice().sort((a, b) => b.startedAt - a.startedAt).forEach((l) => {
    if (!fromLogs.includes(l.task)) fromLogs.push(l.task);
  });
  return fromLogs.slice(0, MAX_TASKS);
}
const setTasks = (t) => save(KEY_TASKS, t.slice(0, MAX_TASKS));

// 同じ「やること」を同じジャンルにまとめるため、空白の揺れをそろえる
const normalizeTask = (s) => s.replace(/[\s　]+/g, " ").trim();

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
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const avgOf = (items) => (items.length ? items.reduce((s, l) => s + l.rating, 0) / items.length : null);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

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

// confirm() が使えない環境でも動くよう、2回押しで確定する
function twoTap(btn, idleText, armedText, action) {
  let timer = null;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (timer) { clearTimeout(timer); timer = null; btn.textContent = idleText; action(); return; }
    btn.textContent = armedText;
    timer = setTimeout(() => { timer = null; btn.textContent = idleText; }, 3000);
  });
}

// 数字のカウントアップ演出
function countUp(node, to, decimals = 0) {
  if (to == null) { node.textContent = "-"; return; }
  if (reducedMotion() || to === 0) { node.textContent = to.toFixed(decimals); return; }
  const start = performance.now(), dur = 700;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    node.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(decimals);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderTiles(container, tiles) {
  container.innerHTML = "";
  tiles.forEach(([value, label, decimals]) => {
    const d = el("div"), b = el("b");
    d.append(b, el("span", null, label));
    container.append(d);
    countUp(b, value, decimals || 0);
  });
}

// ---- views ----
function showView(name) {
  ["timer", "log", "stats", "settings"].forEach((v) => { $(`view-${v}`).hidden = v !== name; });
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "log") renderLog();
  if (name === "stats") renderStats();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

function render() {
  const phase = !current ? "setup" : current.finishedAt ? "rating" : "running";
  $("setup").hidden = phase !== "setup";
  $("resume").hidden = true;
  $("running").hidden = phase !== "running";
  $("rating").hidden = phase !== "rating";
  clearInterval(tick);
  keepAwake(false);
  document.title = "30mm 30分タイマー";
  if (phase === "setup") {
    renderTaskSuggestions();
    renderResume();
  } else if (phase === "running") {
    $("r-task").textContent = current.task;
    $("r-goal").textContent = current.goal;
    update();
    tick = setInterval(update, 250);
    keepAwake(true);
  } else {
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
  const p = (DURATION_MS - left) / DURATION_MS;
  $("bar-fill").style.width = `${p * 100}%`;
  updateBlocks(Math.ceil(left / 60000));
  $("runner").style.left = `calc(${p} * (100% - 40px))`;
  $("trail").style.width = `calc(${p} * (100% - 40px) + 6px)`;
  document.title = `${fmt(left)} ・ ${current.task}`;
}

// ---- 進み方の表示(バー / ブロック / ランナー) ----
const KEY_STYLE = "m30.progressStyle";
const BLOCKS = 30; // 1ブロック = 1分

function setProgressStyle(style) {
  $("progress").dataset.style = style;
  document.querySelectorAll("#style-options .opt").forEach((b) => {
    b.classList.toggle("on", b.dataset.style === style);
    b.setAttribute("aria-checked", String(b.dataset.style === style));
  });
  save(KEY_STYLE, style);
}
$("style-options").addEventListener("click", (e) => {
  const b = e.target.closest(".opt");
  if (b) setProgressStyle(b.dataset.style);
});

// 残り分数ぶんのブロックが点灯し、いま消えかけている1つが点滅する
for (let i = 0; i < BLOCKS; i++) $("blocks").append(el("span"));
document.querySelectorAll(".preview-blocks").forEach((box) => {
  for (let i = 0; i < BLOCKS; i++) box.append(el("span", i < 17 ? "on" : i === 17 ? "on blink" : ""));
});
let shownBlocks = -1;
function updateBlocks(remaining) {
  if (remaining === shownBlocks) return;
  shownBlocks = remaining;
  [...$("blocks").children].forEach((b, i) => {
    b.className = i < remaining - 1 ? "on" : i === remaining - 1 ? "on blink" : "";
  });
}

// 走る犬のドット絵(12×9マス・2コマ)。0コマ目=足を開く、1コマ目=足をそろえる
const RUNNER_FRAMES = [
  [
    "........#...",
    "#.......##..",
    "#......#.##.",
    ".#....######",
    ".########...",
    ".#######....",
    ".#.#...#.#..",
    "#...#.#...#.",
    "#...#.#...#.",
  ],
  [
    "........#...",
    "#.......##..",
    "#......#.##.",
    ".#....######",
    ".########...",
    ".#######....",
    "..#.#.#.#...",
    "..#.#.#.#...",
    "..#.#.#.#...",
  ],
];
const runnerSvg = RUNNER_FRAMES.map((rows, f) =>
  `<g class="f${f}">${rows.map((r, y) => [...r].map((c, x) => (c === "#" ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : "")).join("")).join("")}</g>`
).join("");
document.querySelectorAll(".runner").forEach((svg) => { svg.innerHTML = runnerSvg; });

setProgressStyle(load(KEY_STYLE, "bar"));

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
  if (pipWin) {
    if (aborted) pipWin.close();
    else showPipDone();
  }
  render();
}

// ---- 小窓表示(PC の Chrome / Edge) ----
const KEY_PIP_AUTO = "m30.pipAuto";
const canPip = "documentPictureInPicture" in window && window.top === window; // 埋め込み表示では使えない

async function openPip() {
  if (!canPip || pipWin || !current || current.finishedAt) return;
  try {
    pipWin = await documentPictureInPicture.requestWindow({ width: 320, height: 210 });
  } catch { pipWin = null; return; }
  const d = pipWin.document;
  d.documentElement.lang = "ja";
  if (document.documentElement.dataset.theme) d.documentElement.dataset.theme = document.documentElement.dataset.theme;
  [...document.styleSheets].forEach((ss) => {
    try {
      const s = d.createElement("style");
      s.textContent = [...ss.cssRules].map((r) => r.cssText).join("\n");
      d.head.append(s);
    } catch {
      if (ss.href) { const l = d.createElement("link"); l.rel = "stylesheet"; l.href = ss.href; d.head.append(l); }
    }
  });
  const wrap = el("div", "pip");
  const goal = el("div", "pip-goal", current.goal);
  goal.id = "pip-goal";
  const back = el("button", "primary", "評価する");
  back.id = "pip-back";
  back.hidden = true;
  back.addEventListener("click", () => { window.focus(); pipWin && pipWin.close(); });
  wrap.append(goal, $("clock"), $("progress"), back);
  d.body.append(wrap);
  $("pip").hidden = true;
  // 閉じたら時計と進み方の表示を元の画面へ戻す
  pipWin.addEventListener("pagehide", () => {
    const clock = $("clock"), prog = $("progress"), running = document.getElementById("running");
    prog.hidden = false;
    running.prepend(prog);
    running.prepend(clock);
    pipWin = null;
    $("pip").hidden = !canPip;
  });
}

function showPipDone() {
  $("pip-goal").textContent = "30分経過! おつかれさま";
  $("clock").textContent = "00:00";
  $("progress").hidden = true;
  $("pip-back").hidden = false;
}

$("pip").hidden = !canPip;
$("pip").addEventListener("click", openPip);
$("pip-settings").hidden = !canPip;
$("pip-auto").checked = load(KEY_PIP_AUTO, false);
$("pip-auto").addEventListener("change", (e) => save(KEY_PIP_AUTO, e.target.checked));

// ---- 「やること」の候補 ----
function lastGoalFor(task) {
  const hit = getLogs().filter((l) => l.task === task).sort((a, b) => b.startedAt - a.startedAt)[0];
  return hit ? hit.goal : null;
}

function renderTaskSuggestions() {
  const tasks = getTasks();
  const dl = $("task-list");
  dl.innerHTML = "";
  tasks.forEach((t) => { const o = document.createElement("option"); o.value = t; dl.append(o); });
  const box = $("recent");
  box.innerHTML = "";
  tasks.slice(0, 8).forEach((t) => {
    const chip = el("span", "chip");
    const pick = el("button", "pick", t);
    pick.type = "button";
    pick.addEventListener("click", () => { $("task").value = t; onTaskInput(); $("goal").focus(); });
    const x = el("button", "x", "×");
    x.type = "button";
    x.setAttribute("aria-label", `「${t}」を候補から消す`);
    x.addEventListener("click", () => { setTasks(getTasks().filter((v) => v !== t)); renderTaskSuggestions(); });
    chip.append(pick, x);
    box.append(chip);
  });
}

function onTaskInput() {
  const goal = lastGoalFor(normalizeTask($("task").value));
  $("goal").placeholder = goal ? `前回: ${goal}` : "例: 見出しを5つ決める";
}
$("task").addEventListener("input", onTaskInput);

// ---- 続きから ----
// 直前の記録が5未満なら、その1件だけを続きの候補に出す
let pendingContinue = null; // { id, task }

function resumeCandidates() {
  const last = getLogs().reduce((p, l) => (!p || l.startedAt > p.startedAt ? l : p), null);
  if (!last || last.rating >= 5 || load(KEY_DISMISSED, []).includes(last.id)) return [];
  return [last];
}

function renderResume() {
  const items = resumeCandidates();
  $("resume").hidden = items.length === 0;
  const box = $("resume-list");
  box.innerHTML = "";
  items.forEach((l) => {
    const row = el("div", "resume-item");
    const body = el("div", "resume-body");
    body.append(el("div", "goal", l.goal));
    const meta = el("div", "tags");
    meta.append(el("span", "genre-tag", l.task), el("span", "meta", `達成度 ${l.rating}/5`));
    body.append(meta);
    if (l.note) body.append(el("div", "n", `メモ: ${l.note}`));
    const actions = el("div", "resume-actions");
    const go = el("button", "go", "続きから");
    go.type = "button";
    go.addEventListener("click", () => {
      $("task").value = l.task;
      $("goal").value = l.goal;
      pendingContinue = { id: l.id, task: l.task };
      onTaskInput();
      const start = $("setup").querySelector(".primary");
      start.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
      start.focus({ preventScroll: true });
    });
    const x = el("button", "x", "×");
    x.type = "button";
    x.setAttribute("aria-label", "この候補を消す");
    x.addEventListener("click", () => {
      save(KEY_DISMISSED, [...load(KEY_DISMISSED, []), l.id].slice(-100));
      renderResume();
    });
    actions.append(go, x);
    row.append(body, actions);
    box.append(row);
  });
}

// ---- timer actions ----
$("setup").addEventListener("submit", (e) => {
  e.preventDefault();
  const task = normalizeTask($("task").value), goal = $("goal").value.trim();
  if (!task || !goal) return;
  setTasks([task, ...getTasks().filter((t) => t !== task)]);
  const now = Date.now();
  current = { task, goal, startedAt: now, endsAt: now + DURATION_MS };
  if (pendingContinue && pendingContinue.task === task) current.continuedFrom = pendingContinue.id;
  pendingContinue = null;
  save(KEY_CURRENT, current);
  $("task").value = ""; $("goal").value = "";
  onTaskInput();
  render();
  if (load(KEY_PIP_AUTO, false)) openPip(); // スタートのクリック操作中に開く必要がある
  try {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch { /* ignore */ }
});

twoTap($("abort"), "中断する", "もう一度押すと中断して評価へ", () => finish(true));

$("stars").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  rating = Number(b.dataset.v);
  document.querySelectorAll("#stars button").forEach((x) => x.classList.toggle("on", Number(x.dataset.v) <= rating));
  $("save").disabled = false;
});

const PRAISE = { 5: "完璧!", 4: "いい感じ!", 3: "ナイス集中", 2: "一歩前進", 1: "まず始めたのがえらい" };

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
    continuedFrom: current.continuedFrom || null,
    rating,
    note: $("note").value.trim(),
  });
  setLogs(logs);
  if (pipWin) pipWin.close();
  const todays = logs.filter((l) => dateKey(l.startedAt) === dateKey(Date.now()));
  const mins = todays.reduce((s, l) => s + l.minutes, 0);
  celebrate(rating, PRAISE[rating], `今日 ${todays.length}本目・合計 ${mins}分`);
  current = null;
  try { localStorage.removeItem(KEY_CURRENT); } catch { /* ignore */ }
  render();
  showView("stats");
});

// ---- 演出 ----
let toastTimer = null;
function celebrate(score, title, body) {
  $("toast-title").textContent = title;
  $("toast-body").textContent = body;
  const t = $("toast");
  t.hidden = true; void t.offsetWidth; t.hidden = false; // アニメーションを再生し直す
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  if (!reducedMotion()) confetti(score * 30);
}

function confetti(count) {
  const canvas = $("confetti"), ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e8543a";
  const colors = [accent, "#f2b134", "#3aa1e8", "#4cbf86", "#b07be8"];
  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80,
    y: innerHeight * 0.75,
    vx: (Math.random() - 0.5) * 12,
    vy: -8 - Math.random() * 10,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    s: 5 + Math.random() * 5,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (now) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    parts.forEach((p) => {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    });
    if (now - start < 2200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(frame);
}

// ---- log view ----
function renderLog() {
  const day = $("day").value || dateKey(Date.now());
  $("day").value = day;
  const items = getLogs().filter((l) => dateKey(l.startedAt) === day).sort((a, b) => a.startedAt - b.startedAt);
  renderTiles($("summary"), [
    [items.length, "セッション"],
    [items.reduce((s, l) => s + l.minutes, 0), "合計(分)"],
    [avgOf(items), "平均達成度", 1],
  ]);
  $("empty").hidden = items.length > 0;
  const ol = $("entries");
  ol.innerHTML = "";
  items.forEach((l) => {
    const li = el("li", "entry");
    li.append(el("div", "goal", l.goal));
    const tags = el("div", "tags");
    tags.append(el("span", "genre-tag", l.task));
    if (l.continuedFrom) tags.append(el("span", "meta", "続き"));
    if (l.aborted) tags.append(el("span", "meta", `中断・${l.minutes}分`));
    li.append(tags);
    if (l.note) li.append(el("div", "n", `メモ: ${l.note}`));
    const score = el("div", "score", String(l.rating));
    score.append(el("small", null, "/5"));
    li.append(score);
    const del = el("button", "del", "削除");
    twoTap(del, "削除", "もう一度押すと削除", () => {
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

// ---- stats view ----
function lastDays(n) {
  const today = new Date();
  return Array.from({ length: n }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i)));
}

function streak(logs) {
  const days = new Set(logs.map((l) => dateKey(l.startedAt)));
  const d = new Date();
  if (!days.has(dateKey(d.getTime()))) d.setDate(d.getDate() - 1); // 今日まだでも昨日まで続いていれば数える
  let n = 0;
  while (days.has(dateKey(d.getTime()))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function barPath(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function barChart(svg, data, { max, ticks, format }) {
  const W = 320, H = 170, L = 28, R = 6, T = 16, B = 34;
  const pw = W - L - R, ph = H - T - B, band = pw / data.length, bw = Math.min(24, band * 0.55);
  const y0 = T + ph;
  let s = "";
  ticks.forEach((t) => {
    const y = y0 - (t / max) * ph;
    s += `<line class="${t === 0 ? "base" : "grid"}" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
    s += `<text class="ax" x="${L - 6}" y="${y + 3}" text-anchor="end">${t}</text>`;
  });
  data.forEach((d, i) => {
    const cx = L + band * i + band / 2;
    const tip = `${d.label}(${d.wd}) ${d.value == null ? "記録なし" : format(d.value)}`;
    if (d.value) {
      const h = Math.max(2, (d.value / max) * ph);
      s += `<path class="bar${d.today ? " today" : ""}" style="animation-delay:${i * 60}ms" d="${barPath(cx - bw / 2, y0 - h, bw, h, 4)}"/>`;
      s += `<text class="val" x="${cx}" y="${y0 - h - 5}" text-anchor="middle">${format(d.value)}</text>`;
    }
    s += `<text class="ax${d.today ? " strong" : ""}" x="${cx}" y="${y0 + 14}" text-anchor="middle">${d.label}</text>`;
    s += `<text class="ax${d.today ? " strong" : ""}" x="${cx}" y="${y0 + 27}" text-anchor="middle">${d.today ? "今日" : d.wd}</text>`;
    // ホバー/タップ用の当たり判定(棒より広い)
    s += `<rect class="hit" x="${cx - band / 2}" y="${T}" width="${band}" height="${ph}"><title>${tip}</title></rect>`;
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = s;
}

function renderStats() {
  const logs = getLogs();
  const todayKey = dateKey(Date.now());
  const days = lastDays(7).map((d) => {
    const key = dateKey(d.getTime());
    const items = logs.filter((l) => dateKey(l.startedAt) === key);
    return {
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      wd: WD[d.getDay()],
      today: key === todayKey,
      minutes: items.reduce((s, l) => s + l.minutes, 0),
      avg: avgOf(items),
    };
  });
  const weekItems = logs.filter((l) => l.startedAt >= lastDays(7)[0].getTime());

  renderTiles($("tiles"), [
    [days[6].minutes, "今日の集中(分)"],
    [streak(logs), "連続日数"],
    [avgOf(weekItems), "7日の平均達成度", 1],
  ]);

  const maxMin = Math.max(30, Math.ceil(Math.max(...days.map((d) => d.minutes)) / 30) * 30);
  barChart($("chart-min"), days.map((d) => ({ ...d, value: d.minutes })), {
    max: maxMin, ticks: [0, maxMin / 2, maxMin], format: (v) => `${v}`,
  });
  barChart($("chart-rate"), days.map((d) => ({ ...d, value: d.avg })), {
    max: 5, ticks: [0, 1, 2, 3, 4, 5], format: (v) => v.toFixed(1),
  });

  renderGenres(logs);
}

function renderGenres(logs) {
  const map = new Map();
  logs.forEach((l) => {
    if (!map.has(l.task)) map.set(l.task, []);
    map.get(l.task).push(l);
  });
  const genres = [...map.entries()].map(([task, items]) => ({
    task,
    items: items.sort((a, b) => b.startedAt - a.startedAt),
    minutes: items.reduce((s, l) => s + l.minutes, 0),
    avg: avgOf(items),
  })).sort((a, b) => b.minutes - a.minutes || b.items[0].startedAt - a.items[0].startedAt);

  const box = $("genres");
  box.innerHTML = "";
  $("genres-empty").hidden = genres.length > 0;
  const top = genres.length ? Math.max(1, genres[0].minutes) : 1;
  genres.forEach((g, i) => {
    const det = el("details", "genre");
    const sum = el("summary");
    sum.append(el("span", "name", g.task));
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${(g.minutes / top) * 100}%`;
    fill.style.animationDelay = `${i * 70}ms`;
    track.append(fill);
    sum.append(track);
    sum.append(el("span", "meta", `${g.items.length}回・${g.minutes}分・平均達成度 ${g.avg.toFixed(1)}`));
    det.append(sum);
    const ul = el("ul");
    g.items.slice(0, 10).forEach((l) => {
      const li = el("li");
      const d = new Date(l.startedAt);
      li.append(el("span", null, `${d.getMonth() + 1}/${d.getDate()} ${hhmm(l.startedAt)} ・ ${l.rating}/5 ・ `), document.createTextNode(l.goal));
      ul.append(li);
    });
    det.append(ul);
    box.append(det);
  });
}

// タブが非アクティブでもタイマーが正確になるよう、復帰時に再判定
document.addEventListener("visibilitychange", () => { if (!document.hidden && current && !current.finishedAt) update(); });

$("day").value = dateKey(Date.now());
// 計測中はスマホの画面が消えないようにする(対応ブラウザのみ)
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator && !document.hidden) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current && !current.finishedAt) keepAwake(true);
});

// ホーム画面に追加したときにオフラインでも開けるようにする
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
