/* ============================================================
   便签墙 · 页面逻辑
   - 新建 / 删除 / 自动保存（localStorage）
   - 每张便签单独的颜色（预设 + 任意颜色）
   - 拖动 + 惯性滑行：和 start-page 里的窗口完全同一套手感
   ============================================================ */

/* ---------- 0. 配置 ---------- */
const STORAGE_KEY = "wall-of-notes.v1";
const DEFAULT_COLOR = "#ffd666";

const COLORS = [
  { name: "蜜黄",   hex: "#ffd666" },
  { name: "杏橙",   hex: "#ffb27a" },
  { name: "樱花",   hex: "#ffa8c8" },
  { name: "薄荷",   hex: "#9ae6c1" },
  { name: "天蓝",   hex: "#8cc8ff" },
  { name: "薰衣草", hex: "#c0aaff" },
  { name: "奶油",   hex: "#f5ebc8" },
  { name: "石墨",   hex: "#b8c0d0" },
];

const IGNORE_SEL = "textarea, button, input, label, .swatches";

/* ---------- 1. 小工具 ---------- */
const uid = () => "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function hexToRgb(hex) {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return [255, 214, 102];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 根据底色亮度选黑字或白字，自定义深色便签也看得清
function inkFor(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) > 145 ? "#1b1b22" : "#ffffff";
}

function validColor(c) {
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
}

// 便签不能跑到屏幕外；顶部给工具栏留位置
function clampPos(x, y, w, h) {
  const pad = 8;
  const top = 84;
  return {
    x: clamp(x, pad, Math.max(pad, window.innerWidth - w - pad)),
    y: clamp(y, top, Math.max(top, window.innerHeight - h - pad)),
  };
}

/* ---------- 2. 页面元素 ---------- */
const wall       = document.getElementById("wall");
const emptyEl    = document.getElementById("empty");
const addBtn     = document.getElementById("add-note");
const clearBtn   = document.getElementById("clear-all");
const newColorsEl = document.getElementById("new-colors");

/* ---------- 3. 状态 ---------- */
const order = [];              // 便签的层叠顺序：最后一张在最上面
let newColor = DEFAULT_COLOR;  // 新建便签时用的颜色
let saveTimer = 0;

/* ---------- 4. 保存 / 读取 ---------- */
function collectNotes() {
  // .removing 是正在播放消失动画的便签，不写进存档
  return Array.from(wall.querySelectorAll(".note:not(.removing)")).map((el) => {
    const off = el._drag ? el._drag.offset() : { x: 0, y: 0 };
    return {
      id: el.dataset.id,
      text: el.querySelector(".note-text").value,
      x: Math.round((parseFloat(el.style.left) || 0) + off.x),
      y: Math.round((parseFloat(el.style.top) || 0) + off.y),
      color: el.dataset.color,
    };
  });
}

function saveNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectNotes()));
  } catch (e) {
    // 浏览器禁用 localStorage 时就不保存，页面照常能用
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function loadNotes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;           // 第一次打开
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((n) => n && typeof n === "object")
      .map((n) => ({
        id: String(n.id || uid()),
        text: typeof n.text === "string" ? n.text : "",
        x: Number.isFinite(n.x) ? n.x : 40,
        y: Number.isFinite(n.y) ? n.y : 110,
        color: validColor(n.color) ? n.color : DEFAULT_COLOR,
      }));
  } catch (e) {
    return [];
  }
}

/* ---------- 5. 层叠顺序 ---------- */
function bringToFront(el) {
  const i = order.indexOf(el);
  if (i !== -1) order.splice(i, 1);
  order.push(el);
  order.forEach((n, k) => { n.style.zIndex = String(10 + k); });
}

/* ---------- 6. 拖动 + 惯性滑行 ----------
   这一段和 start-page 的 makeDraggable 是同一套算法，所以手感完全一致：
     - transform 移动，每帧最多更新一次（不触发重新排版）
     - 松手后按最近 100ms 的速度滑行，指数衰减
     - 撞到屏幕边缘就贴边停住
   唯一的区别：便签用 left/top 定位，transform 只负责拖动偏移。 */
function makeDraggable(el, handle, ignoreSel, onEnd) {
  let tx = 0, ty = 0;
  let dragRaf = 0, glideRaf = 0;

  const clampN = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const apply = () => { el.style.transform = "translate3d(" + tx + "px," + ty + "px,0)"; };

  // 便签还能往每个方向挪多远（顶部留出工具栏的高度）
  function bounds() {
    const r = el.getBoundingClientRect();
    const baseL = r.left - tx, baseT = r.top - ty;
    const pad = 8, top = 84;
    return {
      minX: pad - baseL,
      maxX: Math.max(pad - baseL, window.innerWidth - r.width - pad - baseL),
      minY: top - baseT,
      maxY: Math.max(top - baseT, window.innerHeight - r.height - pad - baseT),
    };
  }

  function glide(vx, vy, b) {
    const MAX_SPEED = 2.4;                    // 防止甩飞
    const sp = Math.hypot(vx, vy);
    if (sp < 0.12) return;                    // 太慢就不滑
    if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; }

    // 【改这里】滑行手感：TAU 越大滑得越远、越久（和 start-page 一样是 140）
    const TAU = 140;

    let last = performance.now();
    el.classList.add("gliding");
    const step = (now) => {
      const dt = Math.min(now - last, 40);
      last = now;
      const k = Math.exp(-dt / TAU);
      tx += vx * TAU * (1 - k);
      ty += vy * TAU * (1 - k);
      vx *= k; vy *= k;

      if (tx < b.minX) { tx = b.minX; vx = 0; } else if (tx > b.maxX) { tx = b.maxX; vx = 0; }
      if (ty < b.minY) { ty = b.minY; vy = 0; } else if (ty > b.maxY) { ty = b.maxY; vy = 0; }
      apply();

      if (Math.hypot(vx, vy) > 0.02) {
        glideRaf = requestAnimationFrame(step);
      } else {
        el.classList.remove("gliding");
        if (onEnd) onEnd();                   // 滑行结束，保存最终位置
      }
    };
    glideRaf = requestAnimationFrame(step);
  }

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (ignoreSel && e.target.closest(ignoreSel)) return;

    cancelAnimationFrame(glideRaf);
    el.classList.remove("gliding");

    const b = bounds();
    const startX = e.clientX, startY = e.clientY;
    const baseX = tx, baseY = ty;
    let nx = tx, ny = ty, queued = false;
    const samples = [{ t: performance.now(), x: tx, y: ty }];

    handle.setPointerCapture(e.pointerId);
    el.classList.add("dragging");

    const move = (ev) => {
      nx = clampN(baseX + ev.clientX - startX, b.minX, b.maxX);
      ny = clampN(baseY + ev.clientY - startY, b.minY, b.maxY);
      const now = performance.now();
      samples.push({ t: now, x: nx, y: ny });
      while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
      if (!queued) {
        queued = true;
        dragRaf = requestAnimationFrame(() => { queued = false; tx = nx; ty = ny; apply(); });
      }
    };

    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      cancelAnimationFrame(dragRaf);
      tx = nx; ty = ny; apply();
      el.classList.remove("dragging");

      const now = performance.now();
      const first = samples[0], last = samples[samples.length - 1];
      let vx = 0, vy = 0;
      if (now - last.t < 80 && last.t - first.t > 8) {
        vx = (last.x - first.x) / (last.t - first.t);
        vy = (last.y - first.y) / (last.t - first.t);
      }
      if (onEnd) onEnd();                     // 先存一次松手位置
      glide(vx, vy, b);
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });

  return {
    clamp() {
      const b = bounds();
      tx = clampN(tx, b.minX, b.maxX);
      ty = clampN(ty, b.minY, b.maxY);
      apply();
    },
    offset() {
      return { x: tx, y: ty };
    },
  };
}

/* ---------- 7. 颜色 ---------- */
function applyColor(el, hex) {
  const color = validColor(hex) ? hex.toLowerCase() : DEFAULT_COLOR;
  const [r, g, b] = hexToRgb(color);

  el.dataset.color = color;
  el.style.setProperty("--note-rgb", r + ", " + g + ", " + b);
  el.style.setProperty("--note-ink", inkFor(r, g, b));

  const dot = el.querySelector(".color-dot");
  if (dot) dot.style.background = color;

  const custom = el.querySelector('input[type="color"]');
  if (custom && custom.value.toLowerCase() !== color) custom.value = color;

  el.querySelectorAll(".swatch").forEach((s) => {
    s.classList.toggle("current", s.dataset.color === color);
  });
}

function buildSwatches(el) {
  const box = el.querySelector(".swatches");

  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.color = c.hex;
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute("aria-label", "换成" + c.name);
    b.addEventListener("click", () => {
      applyColor(el, c.hex);
      saveNow();
    });
    box.appendChild(b);
  });

  const custom = document.createElement("label");
  custom.className = "custom-color";
  custom.innerHTML = '自定义 <input type="color">';
  const input = custom.querySelector("input");
  input.setAttribute("aria-label", "自定义便签颜色");
  input.value = el.dataset.color;
  input.addEventListener("input", () => applyColor(el, input.value));
  input.addEventListener("change", () => { applyColor(el, input.value); saveNow(); });
  box.appendChild(custom);
}

function closePalette(el) {
  el.classList.remove("palette-open");
  const btn = el.querySelector(".color-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

/* ---------- 8. 创建一张便签 ---------- */
function createNote(data) {
  const el = document.createElement("article");
  el.className = "note";
  el.dataset.id = data.id;

  el.innerHTML =
    '<div class="note-head">' +
      '<span class="grip" aria-hidden="true"></span>' +
      '<div class="note-actions">' +
        '<button type="button" class="note-btn color-btn" title="换颜色" aria-label="换颜色" aria-expanded="false">' +
          '<span class="color-dot"></span>' +
        '</button>' +
        '<button type="button" class="note-btn del" title="删除便签" aria-label="删除便签">×</button>' +
      '</div>' +
    '</div>' +
    '<textarea class="note-text" maxlength="2000" placeholder="写点什么…" spellcheck="false" aria-label="便签内容"></textarea>' +
    '<div class="swatches" role="group" aria-label="便签颜色"></div>';

  const text = el.querySelector(".note-text");
  text.value = data.text || "";

  // 先放进页面，才能量到真实宽高（窄屏时 CSS 会把它变成 250px）
  wall.appendChild(el);
  el.style.left = "0px";
  el.style.top = "0px";
  const w = el.offsetWidth || 280;
  const h = el.offsetHeight || 216;
  const pos = clampPos(data.x, data.y, w, h);
  el.style.left = pos.x + "px";
  el.style.top = pos.y + "px";

  applyColor(el, data.color);
  buildSwatches(el);
  applyColor(el, data.color);       // 色块建好后再标一次"当前颜色"

  // 点击 / 拖动时置顶；点色板或颜色按钮以外的地方先收起色板
  el.addEventListener("pointerdown", (e) => {
    bringToFront(el);
    if (!e.target.closest(".swatches") && !e.target.closest(".color-btn")) {
      closePalette(el);
    }
  }, true);

  const colorBtn = el.querySelector(".color-btn");
  colorBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = el.classList.toggle("palette-open");
    colorBtn.setAttribute("aria-expanded", String(open));
  });

  el.querySelector(".del").addEventListener("click", (e) => {
    e.stopPropagation();
    removeNote(el);
  });

  text.addEventListener("input", saveSoon);

  el._drag = makeDraggable(el, el, IGNORE_SEL, saveNow);
  bringToFront(el);
  return el;
}

/* ---------- 9. 新建 / 空状态 ---------- */
function nextSpawn() {
  const w = 280, h = 216, gap = 18;
  const cols = Math.max(1, Math.floor((window.innerWidth - 40) / (w + gap)));
  const n = wall.querySelectorAll(".note").length;
  const i = n % (cols * 4);
  return {
    x: 20 + (i % cols) * (w + gap),
    y: 100 + Math.floor(i / cols) * (h + gap),
  };
}

function addNote(x, y) {
  const spawn = (Number.isFinite(x) && Number.isFinite(y))
    ? { x: x - 140, y: y - 108 }            // 从双击点向四周展开
    : nextSpawn();

  const el = createNote({
    id: uid(),
    text: "",
    x: spawn.x,
    y: spawn.y,
    color: newColor,
  });

  updateEmpty();
  saveNow();
  requestAnimationFrame(() => el.querySelector(".note-text").focus());
}

function updateEmpty() {
  emptyEl.hidden = wall.querySelector(".note") !== null;
}

/* 删除一张便签：先播 0.3s 的消失动画，再从页面和存档里移掉 */
function removeNote(el) {
  if (el.classList.contains("removing")) return;

  const i = order.indexOf(el);
  if (i !== -1) order.splice(i, 1);

  el.classList.add("removing");
  saveNow();                       // collectNotes 已经排除 .removing，立刻写掉
  setTimeout(() => {
    el.remove();
    updateEmpty();
    saveNow();
  }, 300);
}

/* ---------- 10. 顶栏：新建颜色 ---------- */
COLORS.forEach((c) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "new-dot" + (c.hex === newColor ? " active" : "");
  b.style.background = c.hex;
  b.title = c.name;
  b.setAttribute("aria-label", "新便签颜色：" + c.name);
  b.addEventListener("click", () => {
    newColor = c.hex;
    newColorsEl.querySelectorAll(".new-dot").forEach((d) => {
      d.classList.toggle("active", d === b);
    });
  });
  newColorsEl.appendChild(b);
});

/* ---------- 11. 事件 ---------- */
addBtn.addEventListener("click", () => addNote());

clearBtn.addEventListener("click", () => {
  const notes = Array.from(wall.querySelectorAll(".note:not(.removing)"));
  if (!notes.length) return;
  if (!window.confirm("清空所有便签？这个操作不能撤销。")) return;

  order.length = 0;
  try { localStorage.setItem(STORAGE_KEY, "[]"); } catch (e) {}

  // 一张接一张地消失，不是"啪"一下全没
  notes.forEach((n, i) => {
    n.style.animationDelay = (i * 24) + "ms";
    n.classList.add("removing");
  });

  setTimeout(() => {
    notes.forEach((n) => n.remove());
    updateEmpty();
  }, 340 + notes.length * 24);
});

// 双击空白处新建（双击便签本身不会触发）
wall.addEventListener("dblclick", (e) => {
  if (e.target.closest(".note")) return;
  addNote(e.clientX, e.clientY);
});

/* 白色光晕跟着鼠标走：把鼠标在便签里的位置写进 --mx / --my。
   每帧最多算一次，不拖慢拖动。 */
let glowRaf = 0;
let glowNote = null, glowX = 0, glowY = 0;

document.addEventListener("mousemove", (e) => {
  const note = e.target.closest ? e.target.closest(".note") : null;
  if (!note) return;

  glowNote = note;
  glowX = e.clientX;
  glowY = e.clientY;

  if (glowRaf) return;
  glowRaf = requestAnimationFrame(() => {
    glowRaf = 0;
    if (!glowNote) return;
    const r = glowNote.getBoundingClientRect();
    glowNote.style.setProperty("--mx", (glowX - r.left) + "px");
    glowNote.style.setProperty("--my", (glowY - r.top) + "px");
  });
});

// 点色板以外的任何地方，收起所有色板
document.addEventListener("pointerdown", (e) => {
  document.querySelectorAll(".note.palette-open").forEach((n) => {
    if (!n.contains(e.target)) closePalette(n);
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".note.palette-open").forEach(closePalette);
});

window.addEventListener("resize", () => {
  document.querySelectorAll(".note").forEach((n) => {
    if (n._drag) n._drag.clamp();
  });
  saveSoon();
});

/* ---------- 12. 启动 ---------- */
const saved = loadNotes();

if (saved === null) {
  // 第一次打开：给一张欢迎便签，顺便演示颜色和拖动
  createNote({
    id: uid(),
    text: "欢迎来到便签墙。\n\n拖住这张卡片可以移动，松手会滑一小段。\n点右上角的圆点换颜色，双击空白处新建。",
    x: 24,
    y: 100,
    color: DEFAULT_COLOR,
  });
  saveNow();
} else {
  saved.forEach(createNote);
}

updateEmpty();

// 关页面 / 切到后台时再存一次，防止刚打完字就关掉丢内容
window.addEventListener("beforeunload", saveNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow();
});
