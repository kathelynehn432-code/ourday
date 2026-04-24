/* ============================================================
   我们的周年倒数 · app.js
   - 读取 content.json
   - 管理 localStorage 进度
   - 每日拆盒 + 补拆逻辑
   - 渲染网格 / 动画 / Modal / 倒计时
   ============================================================ */

(function () {
  'use strict';

  // ---------- Config ----------
  const STORAGE_KEY = 'anniv-countdown-v2';
  const CONTENT_URL = 'content.json';

  // 清掉旧版本的缓存（旧版用的是打乱顺序，会导致可拆位置错乱）
  try { localStorage.removeItem('anniv-countdown-v1'); } catch(e) {}

  // ---------- State ----------
  let CONTENT = null;     // parsed content.json
  let STATE = null;       // { opened: { [day]: ISODate }, seed: number }
  let startDate = null;   // Date at 00:00 local, Day 1
  let annivDate = null;   // Date at 00:00 local, 最后一天
  let TOTAL = 0;          // 总盒子数（由 content.json 决定）

  // ---------- Utils ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /** Parse "YYYY-MM-DD" as a LOCAL midnight Date (no timezone drift). */
  function parseLocalDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  /** Return today at local midnight. */
  function todayMidnight() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 0, 0, 0, 0);
  }

  /** Days between two local midnights (b - a). */
  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }

  /** Current "day number" (1-based). 0 means before start, >68 means after. */
  function currentDayNumber() {
    // Demo/preview mode: ?demo=N pretends today is Day N (doesn't write state)
    const params = new URLSearchParams(location.search);
    const demo = parseInt(params.get('demo'), 10);
    if (!isNaN(demo) && demo > 0) return demo;
    const diff = daysBetween(startDate, todayMidnight());
    return diff + 1;
  }

  /** Format YYYY-MM-DD from local Date. */
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  /** Readable date like "2026年4月24日". */
  function fmtDateCN(d) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  // ---------- Storage ----------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (e) { /* ignore */ }
    return { opened: {}, order: null };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE));
    } catch (e) { console.warn('save failed', e); }
  }

  // ---------- Shuffle (deterministic per device) ----------
  /** Mulberry32 PRNG, seeded. */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Get a device-stable random order over day numbers 1..N.
   * Day 68 (anniversary) is always last; Day 1 (today of install day) is
   * left as first? — No: user asked boxes to be pulled RANDOMLY from the
   * unopened pool each day, regardless of day-number. So we just shuffle
   * the pool, but we PIN day 68 to the last opening so the anniversary
   * surprise is always the anniversary.
   *
   * Strategy: store `order` in state once, which is an array of day
   * numbers representing the "nth pick". order[i] = day number that
   * will be the i-th opened. We generate it once and keep it stable.
   */
  function ensureOrder() {
    // 严格按日期顺序：Day 1 第一个拆，Day 2 第二个拆，...，Day 66 最后一天拆
    if (Array.isArray(STATE.order) && STATE.order.length === CONTENT.boxes.length) return;
    STATE.order = CONTENT.boxes.map(b => b.day).sort((a, b) => a - b);
    saveState();
  }

  // ---------- Derived logic ----------
  /**
   * How many boxes SHOULD be opened by "now"?
   * = clamp(currentDay, 0, totalBoxes)
   */
  function expectedOpenCount() {
    const n = currentDayNumber();
    const total = CONTENT.boxes.length;
    if (n < 1) return 0;
    if (n > total) return total;
    return n;
  }

  function openedCount() {
    return Object.keys(STATE.opened).length;
  }

  /**
   * How many boxes can the user open RIGHT NOW?
   *   expected - opened, capped at 2 (today + 1 makeup for yesterday).
   *   If gap > 2, the oldest ones are permanently missed; user can still
   *   only open 2 today.
   *   Returns 0 if caught up, or if before start.
   */
  function openableNowCount() {
    const n = currentDayNumber();
    if (n < 1) return 0;
    const gap = expectedOpenCount() - openedCount();
    if (gap <= 0) return 0;
    return Math.min(2, gap);
  }

  /**
   * How many boxes are permanently missed (user can never open them).
   * If user is on Day N with K opened, and (N - K) > 2, then (N - K - 2)
   * are missed.
   * But missed slots are PAST day-numbers that were never opened — since
   * our pool is random, we mark the earliest unopened DAYS 1..(N - openable - opened) ... actually
   * we mark them based on pool order: the first (opened + openableNow) slots
   * of STATE.order are "reachable", the slots from there until index (N-1)
   * represent... hmm this gets confusing.
   *
   * Simpler model: "missed" only applies to SLOTS, not specific days.
   * All reachable boxes = opened + openableNow. Remaining future boxes
   * are "locked". Missed boxes don't really need to be tied to a specific
   * day — we just show them as strike-through in the pool order beyond
   * (opened + openableNow) up to (expectedOpenCount - 1).
   *
   * So in the grid, each card's status depends on its INDEX in STATE.order:
   *   idx < openedCount            -> opened (actually: check STATE.opened directly by day)
   *   opened < idx < opened + openable -> available-today
   *   opened + openable <= idx < expected -> missed
   *   idx >= expected              -> locked (future)
   */

  // ---------- Rendering ----------
  function renderAnniversary() {
    const today = todayMidnight();
    const days = daysBetween(today, annivDate);
    const el = $('#anniv-days');
    const sub = $('#anniv-sub');
    if (days > 0) {
      el.textContent = days;
      sub.textContent = `${fmtDateCN(annivDate)} · 还有 ${days} 天`;
    } else if (days === 0) {
      el.textContent = 0;
      sub.textContent = '就是今天 · 周年快乐 ♡';
    } else {
      el.textContent = 0;
      sub.textContent = `${fmtDateCN(annivDate)} · 已经过去 ${-days} 天`;
    }
  }

  function renderProgress() {
    const total = CONTENT.boxes.length;
    const opened = openedCount();
    $('#progress-text').textContent = `${opened} / ${total}`;
    $('#progress-fill').style.width = `${(opened / total) * 100}%`;
  }

  function renderNextTimer() {
    const timer = $('#next-timer');
    const openable = openableNowCount();
    const n = currentDayNumber();
    // show timer only when:
    //  - at least one box is already opened today
    //  - and no more boxes are openable right now
    //  - and we are within the event window
    if (openable === 0 && openedCount() > 0 && n >= 1 && n <= CONTENT.boxes.length) {
      timer.classList.remove('hidden');
      const tomorrow = new Date(todayMidnight().getTime() + 86400000);
      const ms = tomorrow - new Date();
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      $('#next-timer-value').textContent =
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else {
      timer.classList.add('hidden');
    }
  }

  function renderRedeemBanner() {
    const banner = $('#redeem-banner');
    if (openableNowCount() >= 2) {
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderGrid() {
    const grid = $('#grid');
    grid.innerHTML = '';

    const total = CONTENT.boxes.length;
    const opened = openedCount();
    const openable = openableNowCount();
    const expected = expectedOpenCount();

    // Build a map: day -> order-index (position in pool)
    const orderIndex = {};
    STATE.order.forEach((day, i) => { orderIndex[day] = i; });

    // For each box, determine status.
    CONTENT.boxes.forEach(box => {
      const day = box.day;
      const idx = orderIndex[day];
      const btn = document.createElement('button');
      btn.className = 'box';
      btn.setAttribute('role', 'listitem');
      btn.setAttribute('aria-label', `Day ${day}`);
      btn.dataset.day = day;

      // Status determination
      let status = 'locked';
      if (STATE.opened[day]) {
        status = 'opened';
      } else if (idx < opened + openable) {
        // in the "currently openable" slice
        status = 'available';
      } else if (idx < expected) {
        // we've passed this slot's would-be day but user didn't open it
        status = 'missed';
      } else {
        status = 'locked';
      }

      btn.classList.add(status);
      if (day === TOTAL) btn.classList.add('special');

      const isOpened = status === 'opened';
      btn.innerHTML = isOpened
        ? `<div class="box-icon">${escapeHtml(box.icon || '💝')}</div>`
        : `<div class="box-day">${day}</div>`;

      btn.addEventListener('click', () => handleBoxClick(day, status, btn));
      grid.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---------- Interaction ----------
  function handleBoxClick(day, status, btn) {
    if (status === 'locked') {
      shake(btn);
      return;
    }
    if (status === 'missed') {
      shake(btn);
      return;
    }
    if (status === 'opened') {
      showModal(day, { fresh: false });
      return;
    }
    if (status === 'available') {
      // Record open
      STATE.opened[day] = fmtDate(new Date());
      saveState();

      // Play unbox animation at the box's screen position
      const rect = btn.getBoundingClientRect();
      playConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

      // Re-render grid + progress
      setTimeout(() => {
        renderGrid();
        renderProgress();
        renderRedeemBanner();
        renderNextTimer();
        showModal(day, { fresh: true });
      }, 450);
    }
  }

  function shake(el) {
    el.animate([
      { transform: 'translateX(0)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(4px)' },
      { transform: 'translateX(-3px)' },
      { transform: 'translateX(3px)' },
      { transform: 'translateX(0)' }
    ], { duration: 320, easing: 'ease-in-out' });
  }

  function playConfetti(cx, cy) {
    const layer = document.createElement('div');
    layer.className = 'confetti';
    layer.style.left = cx + 'px';
    layer.style.top = cy + 'px';
    const icons = ['♡', '❤', '✨', '🎀', '💖', '🌸'];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.textContent = icons[Math.floor(Math.random() * icons.length)];
      const angle = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.4;
      const dist = 70 + Math.random() * 50;
      s.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
      s.style.setProperty('--ty', Math.sin(angle) * dist - 30 + 'px');
      s.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      s.style.animationDelay = (Math.random() * 0.1) + 's';
      layer.appendChild(s);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 1400);
  }

  // ---------- Modal ----------
  /** Generate a cute kaomoji/decor line based on day number (stable). */
  function modalHeaderLine(day, box) {
    // Kaomoji pool — 无 emoji，纯颜文字
    const kaomojis = [
      '( ˘ ³˘)♡', '₍ᐢ. .ᐢ₎', '(๑˃ᴗ˂)ﻭ', '✧*。٩(ˊᗜˋ*)و✧*。',
      '(*ˊᵕˋ* )੭', '(｡•̀ᴗ-)✧', '(＊꒦ິ꒳꒦ີ)', '♡⃛◟( ˊ̱˂˃ˋ̱ )◞⃛♡',
      '(っ˘ω˘ς )', '(„• ᴗ •„)', '꒰ ♡ ˘ ᗜ ˘ ♡ ꒱', '୧(﹒︠ᴗ﹒︡)୨',
      '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', '(｡◕‿◕｡)', '(≧◡≦) ♡', '૮ ˶ˆᗜˆ˵ ა',
      '໒꒰ྀི⸝⸝> ̫ <⸝⸝꒱ྀི১', '( ˶ˆᗜˆ˵ )', '⸜(｡˃ ᵕ ˂ )⸝♡',
      '(*´꒳`*)', '♡( ◡‿◡ )', '( ꩜ ᯅ ꩜;)', '੭ ᐕ)੭*⁾⁾'
    ];
    // Decorative line accent pool
    const decos = ['♡ ⋆｡˚', '✦ ⋆｡ﾟ', '‧₊˚ ♡', '⋆ ˚｡⋆୨୧˚', '˚₊· ͟͟͞➳❥', '.ᐟ.ᐟ ♡', '❀ ˖°'];
    // Stable-ish pick
    const k = kaomojis[(day * 7 + 3) % kaomojis.length];
    const d = decos[(day * 3) % decos.length];
    return `${d}  Day ${day}  ${k}`;
  }

  function showModal(day, { fresh, preview }) {
    const box = CONTENT.boxes.find(b => b.day === day);
    if (!box) return;
    const openedAt = STATE.opened[day];
    $('#modal-day').textContent = `DAY ${day}${day === TOTAL ? ' · 周年快乐' : ''}${preview ? ' · 预览' : ''}`;
    $('#modal-icon').textContent = box.icon || '💝';
    $('#modal-date').textContent = preview
      ? '（预览模式 · 不影响进度）'
      : (openedAt ? `拆开于 ${openedAt}${fresh ? ' · 今天' : ''}` : '');
    const contentEl = $('#modal-content');
    // 永远自动加上第一行：日期 + 颜文字；下面才是 content.json 的内容
    const header = modalHeaderLine(day, box);
    const body = (box.content && box.content.trim())
      ? box.content
      : '（还没写内容哦 ˃ ᵕ ˂）';
    contentEl.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'modal-header-line';
    h.textContent = header;
    const b = document.createElement('div');
    b.className = 'modal-body-line';
    b.textContent = body;
    contentEl.appendChild(h);
    contentEl.appendChild(b);
    contentEl.classList.remove('modal-empty');
    $('#modal').classList.add('open');
  }

  function hideModal() {
    $('#modal').classList.remove('open');
  }

  // ---------- Boot ----------
  async function loadContent() {
    try {
      const res = await fetch(CONTENT_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error('content.json not found');
      return await res.json();
    } catch (e) {
      console.error(e);
      $('#grid').innerHTML = `<div class="loading" style="grid-column: 1 / -1;">
        无法加载 content.json，请检查文件是否存在。
      </div>`;
      return null;
    }
  }

  async function init() {
    CONTENT = await loadContent();
    if (!CONTENT) return;

    startDate = parseLocalDate(CONTENT.start_date);
    annivDate = parseLocalDate(CONTENT.anniversary_date);
    TOTAL = CONTENT.boxes.length;

    STATE = loadState();
    ensureOrder();

    // event wiring
    $('#modal-close').addEventListener('click', hideModal);
    $('#modal').addEventListener('click', (e) => {
      if (e.target.id === 'modal') hideModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideModal();
    });

    // first paint
    renderAll();

    // keep next-timer and anniversary fresh
    setInterval(() => {
      renderNextTimer();
    }, 1000);
    // midnight re-check: re-render every minute in case a new day starts
    setInterval(() => {
      renderAnniversary();
      renderGrid();
      renderProgress();
      renderRedeemBanner();
    }, 60 * 1000);
  }

  function renderAll() {
    renderAnniversary();
    renderGrid();
    renderProgress();
    renderRedeemBanner();
    renderNextTimer();
  }

  // Start
  window.history.scrollRestoration = 'manual';
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { window.scrollTo(0, 0); init(); });
  } else {
    window.scrollTo(0, 0); init();
  }
})();
