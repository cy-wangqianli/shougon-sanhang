(function () {
  'use strict';

  var STORAGE_KEY = 'shougon-sanhang.v1';
  var IGNORE_NEXT_KEY = STORAGE_KEY + '.ignoreNext';
  var GUIDE_SEEN_KEY = STORAGE_KEY + '.guideSeen';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TAGS = ['比赛', '学习', '生活', '其他'];
  var TAG_CLASS = { 比赛: 'tag-match', 学习: 'tag-study', 生活: 'tag-life', 其他: 'tag-other' };
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var FIELDS = [
    { key: 'progress', label: '推进', reportLabel: '推进' },
    { key: 'blocker', label: '卡点', reportLabel: '卡点' },
    { key: 'next', label: '明天第一步', reportLabel: '明天第一步' }
  ];

  var state = { version: 1, entries: {}, isDemo: false };
  var els = {};
  var isEditingToday = false;
  var pendingDelete = null;
  var collapsedWeeks = new Set();
  var currentReport = '';
  var currentReportFile = '周报.md';
  var reportRange = 'this';
  var toastTimer = null;
  var lastFocused = null;
  var nextStepDismissed = false;
  var suggestedFix = null;
  var fixSuggestTimer = null;
  var onboardingState = 'unset';
  var currentShareImage = '';
  var currentShareFile = '收工三行-周报.png';
  var shareReturnFocus = null;

  /* ---------- 日期 ---------- */

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function dateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function parseDateKey(key) {
    var parts = key.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function addDays(date, amount) {
    var next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    next.setDate(next.getDate() + amount);
    return next;
  }

  function startOfWeek(date) {
    var start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return start;
  }

  function weekdayName(date) {
    return WEEKDAYS[date.getDay()];
  }

  function shortDate(date) {
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  function fullDate(date) {
    return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function sameDay(a, b) {
    return dateKey(a) === dateKey(b);
  }

  /* ---------- 存储 ---------- */

  function cleanText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function readLine(value) {
    if (typeof value === 'string') {
      return { text: cleanText(value), tag: null };
    }
    if (value && typeof value === 'object') {
      return {
        text: cleanText(value.text),
        tag: TAGS.indexOf(value.tag) >= 0 ? value.tag : null
      };
    }
    return { text: '', tag: null };
  }

  function isValidDateKey(key) {
    return DATE_RE.test(key) && dateKey(parseDateKey(key)) === key;
  }

  function sanitizeEntries(raw, stats) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (key) {
      var day = raw[key];
      if (!isValidDateKey(key) || !day || typeof day !== 'object' || Array.isArray(day)) {
        if (stats) stats.skipped += 1;
        return;
      }
      var entry = {
        progress: readLine(day.progress),
        blocker: readLine(day.blocker),
        next: readLine(day.next),
        updatedAt: typeof day.updatedAt === 'string' ? day.updatedAt : null
      };
      // fix 是后加的可选字段：旧数据没有也能直接读，只有非空时才保留
      if (day.blocker && typeof day.blocker === 'object') {
        var fix = cleanText(day.blocker.fix);
        if (fix) entry.blocker.fix = fix;
      }
      if (entry.progress.text || entry.blocker.text || entry.next.text) {
        out[key] = entry;
      } else if (stats) {
        stats.skipped += 1;
      }
    });
    return out;
  }

  function showStorageWarn() {
    if (els.storageWarn) els.storageWarn.hidden = false;
  }

  function hideStorageWarn() {
    if (els.storageWarn) els.storageWarn.hidden = true;
  }

  function probeStorage() {
    try {
      var probe = STORAGE_KEY + '.probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (error) {
      console.warn('本地存储不可用', error);
      return false;
    }
  }

  function readRawEntries() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      if (parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
      return parsed;
    } catch (error) {
      console.warn('读取本地记录失败', error);
      if (raw) {
        try {
          localStorage.setItem(STORAGE_KEY + '.broken.' + Date.now(), raw);
        } catch (backupError) {
          console.warn('备份损坏数据失败', backupError);
        }
      }
      showStorageWarn();
      return {};
    }
  }

  function persist() {
    // 示例数据只在内存里，任何写入都要在 isDemo 清零之后发生，避免假记录落盘
    if (state.isDemo) return true;
    try {
      if (Object.keys(state.entries).length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: state.entries }));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      hideStorageWarn();
      return true;
    } catch (error) {
      console.warn('写入本地记录失败', error);
      showStorageWarn();
      return false;
    }
  }

  function computeStreak() {
    var cursor = new Date();
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
    if (!state.entries[dateKey(cursor)]) {
      cursor = addDays(cursor, -1);
    }
    var count = 0;
    while (state.entries[dateKey(cursor)]) {
      count += 1;
      cursor = addDays(cursor, -1);
    }
    return count;
  }

  function computeLongestStreak() {
    var keys = Object.keys(state.entries).filter(function (key) {
      return DATE_RE.test(key);
    }).sort();

    var best = 0;
    var run = 0;
    var previous = null;

    keys.forEach(function (key) {
      if (previous && dateKey(addDays(parseDateKey(previous), 1)) === key) {
        run += 1;
      } else {
        run = 1;
      }
      if (run > best) best = run;
      previous = key;
    });

    return best;
  }

  function computeMonthStats() {
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth();
    var total = new Date(year, month + 1, 0).getDate();
    var count = 0;

    for (var day = 1; day <= total; day += 1) {
      if (state.entries[dateKey(new Date(year, month, day))]) count += 1;
    }

    return { count: count, total: total, longest: computeLongestStreak() };
  }

  /* ---------- 渲染：头部与今日 ---------- */

  function renderHeader() {
    var now = new Date();
    els.todayDate.textContent = fullDate(now);
    els.todayWeekday.textContent = weekdayName(now);

    var streak = computeStreak();
    els.streakText.textContent = '连续打卡 ' + streak + ' 天';
    els.streak.classList.toggle('is-zero', streak === 0);

    var stats = computeMonthStats();
    els.statsText.textContent = '本月 ' + stats.count + '/' + stats.total + ' 天 · 最长连续 ' + stats.longest + ' 天';
  }

  function el(tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildLine(field, line) {
    var row = el('div', 'entry-line');
    row.appendChild(el('span', 'line-label', field.label));
    var text = el('span', 'line-text');
    text.appendChild(document.createTextNode(line.text));
    if (line.tag) {
      text.appendChild(el('span', 'tag ' + (TAG_CLASS[line.tag] || 'tag-other'), line.tag));
    }
    if (field.key === 'blocker' && line.fix) {
      text.appendChild(el('span', 'line-fix', '解法：' + line.fix));
    }
    row.appendChild(text);
    return row;
  }

  function renderSavedLines(entry) {
    els.todaySavedLines.replaceChildren();
    FIELDS.forEach(function (field) {
      var line = entry[field.key];
      if (line && line.text) {
        els.todaySavedLines.appendChild(buildLine(field, line));
      }
    });
  }

  function renderCompose() {
    var entry = state.entries[todayKey()];
    var showSaved = Boolean(entry) && !isEditingToday;

    els.entryForm.hidden = showSaved;
    els.todaySaved.hidden = !showSaved;
    els.saveLabel.textContent = entry ? '更新今日三行' : '保存今日三行';
    els.fixAfterBtn.hidden = !(entry && entry.blocker && entry.blocker.text);

    if (showSaved) {
      els.composeHint.textContent = '今天已收工，想修改就点编辑。';
      renderSavedLines(entry);
    } else if (entry) {
      els.composeHint.textContent = '正在编辑今天的记录，保存后会覆盖。';
    } else {
      els.composeHint.textContent = '写完三行就算收工，不追求完美。';
    }
  }

  function setFixExpanded(expanded) {
    els.fixArea.hidden = !expanded;
    els.fixToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    els.fixToggle.textContent = expanded ? '收起解法' : '＋ 记下解法';
  }

  function fillForm(entry) {
    FIELDS.forEach(function (field) {
      var line = entry ? entry[field.key] : null;
      els[field.key].value = line ? line.text : '';
      var tagSelect = els[field.key + 'Tag'];
      tagSelect.value = line && line.tag ? line.tag : '';
    });
    var fix = entry && entry.blocker && entry.blocker.fix ? entry.blocker.fix : '';
    els.fix.value = fix;
    setFixExpanded(Boolean(fix));
    hideFormError();
  }

  function clearForm() {
    fillForm(null);
  }

  /* ---------- 卡点解法库 ---------- */

  // 归一化成可比较的词：英文/数字按词，中文按二元组；标点与空白直接丢掉
  function tokenizeForMatch(text) {
    var lower = String(text || '').toLowerCase();
    var tokens = [];
    var words = lower.match(/[a-z0-9]{2,}/g);
    if (words) tokens = tokens.concat(words);
    var runs = lower.match(/[\u4e00-\u9fff]+/g) || [];
    runs.forEach(function (run) {
      if (run.length === 1) {
        tokens.push(run);
        return;
      }
      for (var i = 0; i < run.length - 1; i += 1) {
        tokens.push(run.slice(i, i + 2));
      }
    });
    return tokens;
  }

  function matchScore(aTokens, bTokens) {
    if (!aTokens.length || !bTokens.length) return 0;
    var pool = Object.create(null);
    aTokens.forEach(function (token) {
      pool[token] = true;
    });
    var shared = 0;
    var seen = Object.create(null);
    bTokens.forEach(function (token) {
      if (pool[token] && !seen[token]) {
        seen[token] = true;
        shared += 1;
      }
    });
    return shared / Math.min(aTokens.length, bTokens.length);
  }

  // 最近 30 条带解法的历史卡点（今天的除外）
  function collectFixHistory() {
    var today = todayKey();
    var out = [];
    Object.keys(state.entries).filter(function (key) {
      return DATE_RE.test(key) && key !== today;
    }).sort().reverse().forEach(function (key) {
      if (out.length >= 30) return;
      var blocker = state.entries[key].blocker;
      if (blocker && blocker.text && blocker.fix) {
        out.push({ key: key, text: blocker.text, fix: blocker.fix });
      }
    });
    return out;
  }

  function findSimilarFix(text) {
    var tokens = tokenizeForMatch(text);
    if (!tokens.length) return null;
    if (tokens.length === 1 && tokens[0].length < 2) return null;

    var best = null;
    collectFixHistory().forEach(function (item) {
      var score = matchScore(tokens, tokenizeForMatch(item.text));
      if (score >= 0.5 && (!best || score > best.score)) {
        best = { item: item, score: score };
      }
    });
    return best ? best.item : null;
  }

  function hideFixSuggestion() {
    suggestedFix = null;
    if (!els.fixSuggest) return;
    els.fixSuggest.hidden = true;
    els.fixSuggestText.textContent = '';
  }

  function updateFixSuggestion() {
    var text = cleanText(els.blocker.value);
    if (!text) {
      hideFixSuggestion();
      return;
    }

    var match = findSimilarFix(text);
    if (!match || cleanText(els.fix.value) === match.fix) {
      hideFixSuggestion();
      return;
    }

    suggestedFix = match;
    els.fixSuggestText.textContent = '上次你卡在类似问题：' + match.text + ' → ' + match.fix;
    els.fixSuggest.hidden = false;
  }

  function applySuggestedFix() {
    if (!suggestedFix) return;
    els.fix.value = suggestedFix.fix;
    setFixExpanded(true);
    hideFixSuggestion();
    els.fix.focus();
    toast('已引用上次的解法');
  }

  function scheduleFixSuggestion() {
    if (fixSuggestTimer) clearTimeout(fixSuggestTimer);
    fixSuggestTimer = setTimeout(updateFixSuggestion, 180);
  }

  /* ---------- 渲染：时间轴 ---------- */

  function formatWeekRange(start) {
    var end = addDays(start, 6);
    var startYear = start.getFullYear();
    var endYear = end.getFullYear();
    var text;

    if (startYear !== endYear) {
      text = startYear + '年' + (start.getMonth() + 1) + '月' + start.getDate() + '日 – ' +
        endYear + '年' + (end.getMonth() + 1) + '月' + end.getDate() + '日';
    } else if (start.getMonth() === end.getMonth()) {
      text = (start.getMonth() + 1) + '月' + start.getDate() + '日 – ' + end.getDate() + '日';
    } else {
      text = (start.getMonth() + 1) + '月' + start.getDate() + '日 – ' +
        (end.getMonth() + 1) + '月' + end.getDate() + '日';
    }

    if (startYear === endYear && startYear !== new Date().getFullYear()) {
      text = startYear + '年' + text;
    }
    return text;
  }

  function buildEntry(key, entry) {
    var date = parseDateKey(key);
    var card = el('article', 'paper entry');
    card.dataset.date = key;

    var head = el('div', 'entry-head');
    var dateWrap = el('div', 'entry-date');
    dateWrap.appendChild(el('span', 'entry-day', shortDate(date)));
    dateWrap.appendChild(el('span', 'entry-weekday', weekdayName(date)));
    if (sameDay(date, new Date())) {
      dateWrap.appendChild(el('span', 'today-badge', '今天'));
    }
    head.appendChild(dateWrap);

    var actions = el('div', 'entry-actions');
    if (pendingDelete === key) {
      actions.appendChild(el('span', 'confirm-label', '删除这天的记录？'));
      var confirmBtn = el('button', 'btn tiny danger', '确认删除');
      confirmBtn.type = 'button';
      confirmBtn.dataset.action = 'confirm-delete';
      confirmBtn.dataset.date = key;
      var cancelBtn = el('button', 'btn tiny', '取消');
      cancelBtn.type = 'button';
      cancelBtn.dataset.action = 'cancel-delete';
      cancelBtn.dataset.date = key;
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
    } else {
      var deleteBtn = el('button', 'btn tiny ghost', '删除');
      deleteBtn.type = 'button';
      deleteBtn.dataset.action = 'ask-delete';
      deleteBtn.dataset.date = key;
      deleteBtn.setAttribute('aria-label', '删除 ' + shortDate(date) + ' 的记录');
      actions.appendChild(deleteBtn);
    }
    head.appendChild(actions);

    var lines = el('div', 'entry-lines');
    FIELDS.forEach(function (field) {
      var line = entry[field.key];
      if (line && line.text) lines.appendChild(buildLine(field, line));
    });

    card.appendChild(head);
    card.appendChild(lines);
    return card;
  }

  function buildWeek(weekKey, dayKeys, flags) {
    var wrap = el('div', 'week');
    var start = parseDateKey(weekKey);
    var collapsed = collapsedWeeks.has(weekKey);

    var head = el('button', 'week-head');
    head.type = 'button';
    head.dataset.action = 'toggle-week';
    head.dataset.week = weekKey;
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

    var range = el('span', 'week-range', formatWeekRange(start));
    if (flags.current) {
      range.appendChild(el('em', 'week-badge', '本周'));
    } else if (flags.previous) {
      range.appendChild(el('em', 'week-badge ghost', '上周'));
    }

    var count = el('span', 'week-count', dayKeys.length + ' 天');
    var chevron = el('span', 'chevron');
    chevron.setAttribute('aria-hidden', 'true');

    head.appendChild(range);
    head.appendChild(count);
    head.appendChild(chevron);

    var body = el('div', 'week-body');
    body.hidden = collapsed;
    dayKeys.forEach(function (key) {
      body.appendChild(buildEntry(key, state.entries[key]));
    });

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  function buildEmptyState() {
    var box = el('div', 'empty paper');
    box.appendChild(el('p', 'empty-title', '还没有记录'));
    box.appendChild(el('p', 'empty-text', '写下今天的三行，这里会按周排好。'));
    return box;
  }

  function renderTimeline() {
    els.timelineList.replaceChildren();

    var keys = Object.keys(state.entries).filter(function (key) {
      return DATE_RE.test(key);
    }).sort().reverse();

    if (!keys.length) {
      els.timelineMeta.textContent = '还没有记录';
      els.timelineList.appendChild(buildEmptyState());
      return;
    }

    var groups = new Map();
    keys.forEach(function (key) {
      var weekKey = dateKey(startOfWeek(parseDateKey(key)));
      if (!groups.has(weekKey)) groups.set(weekKey, []);
      groups.get(weekKey).push(key);
    });

    var weeks = Array.from(groups.keys()).sort().reverse();
    var currentWeek = dateKey(startOfWeek(new Date()));
    var previousWeek = dateKey(addDays(startOfWeek(new Date()), -7));

    els.timelineMeta.textContent = '共 ' + keys.length + ' 天 · ' + weeks.length + ' 周';

    weeks.forEach(function (weekKey) {
      els.timelineList.appendChild(buildWeek(weekKey, groups.get(weekKey), {
        current: weekKey === currentWeek,
        previous: weekKey === previousWeek
      }));
    });
  }

  function renderAll() {
    renderHeader();
    renderCompose();
    renderTimeline();
    renderTopBanners();
    renderOnboarding();
    els.guideCard.hidden = Object.keys(state.entries).length > 0;
  }

  /* ---------- 交互 ---------- */

  function showFormError(message) {
    els.formError.textContent = message;
    els.formError.hidden = false;
  }

  function hideFormError() {
    els.formError.hidden = true;
  }

  function handleSubmit(event) {
    event.preventDefault();

    // 第一次写自己的内容时，把示例数据整体清掉，避免假记录混进时间轴
    if (state.isDemo) {
      state.entries = {};
      state.isDemo = false;
    }

    var key = todayKey();
    var entry = { updatedAt: new Date().toISOString() };
    var hasAny = false;

    FIELDS.forEach(function (field) {
      var textEl = els[field.key];
      var tagEl = els[field.key + 'Tag'];
      var text = cleanText(textEl.value);
      var tag = text && TAGS.indexOf(tagEl.value) >= 0 ? tagEl.value : null;
      entry[field.key] = { text: text, tag: tag };
      textEl.value = text;
      if (text) hasAny = true;
    });

    // 解法是可选字段：卡点为空就不保留，有内容才写进 blocker.fix
    var fixText = entry.blocker.text ? cleanText(els.fix.value) : '';
    if (fixText) entry.blocker.fix = fixText;
    els.fix.value = fixText;
    hideFixSuggestion();

    if (!hasAny) {
      showFormError('至少写一行再收工，哪怕只有半句。');
      els.progress.focus();
      return;
    }

    hideFormError();
    state.entries[key] = entry;
    var saved = persist();
    isEditingToday = false;
    renderAll();
    if (saved) {
      popStamp();
      toast('已保存 · 连续打卡 ' + computeStreak() + ' 天');
      els.editTodayBtn.focus();
    }
  }

  function toggleWeek(button) {
    var weekKey = button.dataset.week;
    var body = button.parentElement.querySelector('.week-body');
    if (!body) return;

    var willCollapse = !body.hidden;
    body.hidden = willCollapse;
    button.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');

    if (willCollapse) {
      collapsedWeeks.add(weekKey);
    } else {
      collapsedWeeks.delete(weekKey);
    }
  }

  function deleteEntry(key) {
    var date = parseDateKey(key);
    delete state.entries[key];
    pendingDelete = null;

    if (key === todayKey()) {
      clearForm();
      isEditingToday = false;
    }

    var saved = persist();
    renderAll();
    if (saved) toast('已删除 ' + shortDate(date) + ' 的记录');
    els.timelineList.focus();
  }

  function focusTimelineAction(action, key) {
    var button = els.timelineList.querySelector(
      '[data-action="' + action + '"][data-date="' + key + '"]'
    );
    if (button) button.focus();
  }

  function handleTimelineClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var button = target.closest('[data-action]');
    if (!button) return;

    var action = button.dataset.action;
    if (action === 'toggle-week') {
      toggleWeek(button);
      return;
    }

    var key = button.dataset.date;
    if (action === 'ask-delete' && key) {
      pendingDelete = key;
      renderTimeline();
      focusTimelineAction('confirm-delete', key);
    } else if (action === 'cancel-delete') {
      pendingDelete = null;
      renderTimeline();
      focusTimelineAction('ask-delete', key);
    } else if (action === 'confirm-delete' && key) {
      deleteEntry(key);
    }
  }

  /* ---------- 周报 ---------- */

  function weekStartFor(range) {
    var start = startOfWeek(new Date());
    return range === 'last' ? addDays(start, -7) : start;
  }

  function collectWeekDays(weekStart) {
    var days = [];

    for (var i = 0; i < 7; i += 1) {
      var date = addDays(weekStart, i);
      var key = dateKey(date);
      if (state.entries[key]) {
        days.push({ date: date, entry: state.entries[key] });
      }
    }

    return days;
  }

  // 卡点粗分类：按关键词命中，没命中归「其他」。顺序即优先级。
  var BLOCKER_CATEGORIES = [
    { name: '环境配置', keywords: ['环境', '配置', '安装', '依赖', '版本', '路径', '权限', '编译', '构建', 'node', 'npm', '证书', '环境变量', 'safari', '兼容', '白边', '缓存', 'cors', '跨域', '端口'] },
    { name: '工具问题', keywords: ['工具', '软件', 'bug', '报错', '崩溃', '闪退', '加载', '卡顿', '插件', '编辑器', '服务器', '网络', 'git', '接口', 'api'] },
    { name: '沟通协作', keywords: ['沟通', '协作', '会议', '同步', '对齐', '反馈', '讨论', '同学', '同事', '团队', '分工', '催'] },
    { name: '时间安排', keywords: ['时间', '计划', '排期', '安排', '效率', '分心', '犯困', '加班', '拖延', 'deadline', '排太满', '进度', '节奏'] }
  ];

  function classifyBlocker(text) {
    var lower = String(text).toLowerCase();
    for (var i = 0; i < BLOCKER_CATEGORIES.length; i += 1) {
      var cat = BLOCKER_CATEGORIES[i];
      for (var j = 0; j < cat.keywords.length; j += 1) {
        if (lower.indexOf(cat.keywords[j].toLowerCase()) >= 0) return cat.name;
      }
    }
    return '其他';
  }

  function formatReportRange(weekStart) {
    var weekEnd = addDays(weekStart, 6);
    return weekStart.getFullYear() === weekEnd.getFullYear()
      ? fullDate(weekStart) + ' – ' + shortDate(weekEnd)
      : fullDate(weekStart) + ' – ' + fullDate(weekEnd);
  }

  function blockerFixSuffix(line) {
    return line && line.fix ? ' ｜ 解法：' + line.fix : '';
  }

  function buildWeeklyReport(weekStart, label) {
    var days = collectWeekDays(weekStart);
    if (!days.length) return '';

    var rangeText = formatReportRange(weekStart);
    var out = [];

    out.push('# 收工三行 · 周报');
    out.push('');
    out.push(rangeText + ' ｜ ' + label + '记录 ' + days.length + ' 天');
    out.push('');

    days.forEach(function (item) {
      out.push('## ' + shortDate(item.date) + ' ' + weekdayName(item.date));
      out.push('');
      FIELDS.forEach(function (field) {
        var line = item.entry[field.key];
        if (!line || !line.text) return;
        var tag = line.tag ? '（' + line.tag + '）' : '';
        var fix = field.key === 'blocker' ? blockerFixSuffix(line) : '';
        out.push('- **' + field.reportLabel + '**：' + line.text + tag + fix);
      });
      out.push('');
    });

    var blockers = days.filter(function (item) {
      return item.entry.blocker && item.entry.blocker.text;
    });

    // 本周最常卡在哪：按关键词聚类，放在「卡点」之前；没有卡点就整节省略
    if (blockers.length) {
      var buckets = { 其他: [] };
      BLOCKER_CATEGORIES.forEach(function (cat) {
        buckets[cat.name] = [];
      });
      blockers.forEach(function (item) {
        var cat = classifyBlocker(item.entry.blocker.text);
        if (!buckets[cat]) buckets[cat] = [];
        buckets[cat].push(item);
      });

      var order = Object.keys(buckets).filter(function (name) {
        return buckets[name].length > 0;
      }).sort(function (a, b) {
        return buckets[b].length - buckets[a].length;
      });

      out.push('## ' + label + '最常卡在哪');
      out.push('');
      order.forEach(function (name) {
        out.push('- **' + name + '**（' + buckets[name].length + ' 次）');
        buckets[name].forEach(function (item) {
          var tag = item.entry.blocker.tag ? '（' + item.entry.blocker.tag + '）' : '';
          out.push('  - ' + shortDate(item.date) + ' ' + weekdayName(item.date) + '：' + item.entry.blocker.text + tag);
        });
      });
      out.push('');
    }

    out.push('## ' + label + '卡点');
    out.push('');
    if (blockers.length) {
      blockers.forEach(function (item) {
        var tag = item.entry.blocker.tag ? '（' + item.entry.blocker.tag + '）' : '';
        out.push('- **' + shortDate(item.date) + '**：' + item.entry.blocker.text + tag + blockerFixSuffix(item.entry.blocker));
      });
    } else {
      out.push('- ' + label + '没有记录卡点。');
    }
    out.push('');
    out.push('---');
    out.push('');
    out.push('由「收工三行」自动生成');

    return out.join('\n');
  }

  function renderReport() {
    var weekStart = weekStartFor(reportRange);
    var label = reportRange === 'last' ? '上周' : '本周';
    var report = buildWeeklyReport(weekStart, label);

    currentReport = report;
    currentReportFile = '周报-' + dateKey(weekStart) + '.md';
    els.reportTitle.textContent = label + '周报';

    Array.prototype.forEach.call(els.reportRange.querySelectorAll('[data-range]'), function (button) {
      var active = button.dataset.range === reportRange;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    if (!report) {
      els.reportText.hidden = true;
      els.reportText.textContent = '';
      els.reportEmpty.hidden = false;
      els.reportEmpty.textContent = reportRange === 'last'
        ? '上周没有记录，本周可以重新攒起来。'
        : '本周还没有记录，先写下今天的三行吧。';
      els.copyBtn.disabled = true;
      els.downloadBtn.disabled = true;
      els.shareBtn.disabled = true;
      return;
    }

    els.reportEmpty.hidden = true;
    els.reportText.hidden = false;
    els.reportText.textContent = report;
    els.copyBtn.disabled = false;
    els.downloadBtn.disabled = false;
    els.shareBtn.disabled = false;
    els.copyBtn.textContent = '复制到剪贴板';
  }

  function openReport() {
    reportRange = 'this';
    renderReport();

    lastFocused = document.activeElement;
    els.reportModal.hidden = false;
    if (els.shell) els.shell.inert = true;
    document.body.classList.add('modal-open');
    els.modalPanel.focus();
  }

  function downloadReport() {
    if (!currentReport) return;

    var blob = new Blob([currentReport], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = currentReportFile;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    toast('周报已下载');
  }

  /* ---------- 周报分享图 ---------- */

  var SHARE_SERIF = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "STSong", "SimSun", Georgia, serif';
  var SHARE_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  function buildShareData(weekStart) {
    var days = collectWeekDays(weekStart);
    var progress = [];
    var counts = {};

    days.forEach(function (item) {
      var line = item.entry.progress;
      if (line && line.text && progress.length < 3) progress.push(line.text);

      var blocker = item.entry.blocker;
      if (blocker && blocker.text) {
        var name = classifyBlocker(blocker.text);
        counts[name] = (counts[name] || 0) + 1;
      }
    });

    var top = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a];
    }).slice(0, 2).map(function (name) {
      return { name: name, count: counts[name] };
    });

    return {
      days: days.length,
      progress: progress,
      top: top,
      streak: computeStreak()
    };
  }

  function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    var chars = String(text).split('');
    var lines = [];
    var line = '';
    var used = 0;

    for (var i = 0; i < chars.length; i += 1) {
      var candidate = line + chars[i];
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = chars[i];
        if (lines.length === maxLines) break;
      } else {
        line = candidate;
      }
      used = i + 1;
    }

    if (lines.length < maxLines && line) lines.push(line);

    if (used < chars.length && lines.length) {
      var last = lines[lines.length - 1];
      while (last && ctx.measureText(last + '…').width > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[lines.length - 1] = last + '…';
    }

    lines.forEach(function (item, index) {
      ctx.fillText(item, x, y + index * lineHeight);
    });

    return y + lines.length * lineHeight;
  }

  function renderShareCard() {
    var weekStart = weekStartFor(reportRange);
    var label = reportRange === 'last' ? '上周' : '本周';
    var data = buildShareData(weekStart);
    if (!data.days) return false;

    var dark = false;
    try {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (error) {
      dark = false;
    }

    var c = dark
      ? { bg: '#15130f', ink: '#ece4d6', ink2: '#b4aa99', ink3: '#9a9080', line: 'rgba(236, 228, 214, 0.22)', accent: '#d97752' }
      : { bg: '#f4efe4', ink: '#221f1a', ink2: '#5d5549', ink3: '#6b6255', line: 'rgba(54, 45, 32, 0.22)', accent: '#a34728' };

    var canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    var ctx = canvas.getContext('2d');
    if (!ctx) return false;

    var pad = 84;
    var inner = 1080 - pad * 2;

    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, 1080, 1350);
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.strokeRect(36, 36, 1008, 1278);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = c.ink3;
    ctx.font = '500 22px ' + SHARE_SANS;
    ctx.fillText('WEEKLY REVIEW', pad, 142);

    ctx.fillStyle = c.ink;
    ctx.font = '600 62px ' + SHARE_SERIF;
    ctx.fillText('收工三行 · ' + label + '周报', pad, 226);

    ctx.fillStyle = c.ink2;
    ctx.font = '400 30px ' + SHARE_SANS;
    ctx.fillText(formatReportRange(weekStart), pad, 286);

    ctx.strokeStyle = c.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, 328);
    ctx.lineTo(1080 - pad, 328);
    ctx.stroke();

    ctx.fillStyle = c.ink3;
    ctx.font = '400 25px ' + SHARE_SANS;
    ctx.fillText('本周记录', pad, 390);
    ctx.fillText('连续打卡', pad + 440, 390);

    ctx.fillStyle = c.ink;
    ctx.font = '600 74px ' + SHARE_SERIF;
    ctx.fillText(data.days + ' 天', pad, 470);
    ctx.fillText(data.streak + ' 天', pad + 440, 470);

    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(pad, 514);
    ctx.lineTo(1080 - pad, 514);
    ctx.stroke();

    var y = 596;
    ctx.fillStyle = c.accent;
    ctx.font = '600 28px ' + SHARE_SANS;
    ctx.fillText('本周推进', pad, y);

    ctx.font = '400 36px ' + SHARE_SANS;
    y += 62;
    if (data.progress.length) {
      data.progress.forEach(function (text) {
        ctx.fillStyle = c.accent;
        ctx.fillText('·', pad, y);
        ctx.fillStyle = c.ink;
        y = drawWrappedText(ctx, text, pad + 30, y, inner - 30, 50, 2);
        y += 20;
      });
    } else {
      ctx.fillStyle = c.ink3;
      ctx.fillText('这周还没有记录推进。', pad, y);
      y += 56;
    }

    var blockerY = Math.max(y + 44, 980);
    ctx.fillStyle = c.accent;
    ctx.font = '600 28px ' + SHARE_SANS;
    ctx.fillText('卡点 Top 2', pad, blockerY);

    ctx.font = '400 36px ' + SHARE_SANS;
    blockerY += 58;
    if (data.top.length) {
      data.top.forEach(function (item, index) {
        ctx.fillStyle = c.accent;
        ctx.fillText('0' + (index + 1), pad, blockerY);
        ctx.fillStyle = c.ink;
        ctx.fillText(item.name + ' · ' + item.count + ' 次', pad + 66, blockerY);
        blockerY += 54;
      });
    } else {
      ctx.fillStyle = c.ink3;
      ctx.fillText('本周没有记录卡点。', pad, blockerY);
    }

    ctx.fillStyle = c.ink3;
    ctx.font = '400 28px ' + SHARE_SANS;
    ctx.fillText('每天三行，周末自动变周报', pad, 1268);

    ctx.textAlign = 'right';
    ctx.fillStyle = c.accent;
    ctx.font = '500 26px ' + SHARE_SERIF;
    ctx.fillText('收工三行', 1080 - pad, 1268);
    ctx.textAlign = 'left';

    currentShareImage = canvas.toDataURL('image/png');
    currentShareFile = '收工三行-周报-' + dateKey(weekStart) + '.png';
    return true;
  }

  function openSharePreview() {
    if (!renderShareCard()) {
      toast('这周还没有记录，先写几行再生成分享图');
      return;
    }
    els.shareImage.src = currentShareImage;
    shareReturnFocus = document.activeElement;
    els.shareModal.hidden = false;
    els.sharePanel.focus();
  }

  function closeSharePreview() {
    if (els.shareModal.hidden) return;
    els.shareModal.hidden = true;
    els.shareImage.removeAttribute('src');
    if (shareReturnFocus && typeof shareReturnFocus.focus === 'function' && document.contains(shareReturnFocus)) {
      shareReturnFocus.focus();
    }
  }

  function downloadShareImage() {
    if (!currentShareImage) return;
    var link = document.createElement('a');
    link.href = currentShareImage;
    link.download = currentShareFile;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast('分享图已下载');
  }

  function closeReport() {
    if (els.reportModal.hidden) return;
    els.reportModal.hidden = true;
    if (els.shell) els.shell.inert = false;
    document.body.classList.remove('modal-open');
    if (lastFocused && typeof lastFocused.focus === 'function' && document.contains(lastFocused)) {
      lastFocused.focus();
    }
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-9999px';
    document.body.appendChild(area);
    area.select();

    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (error) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function selectReportText() {
    var range = document.createRange();
    range.selectNodeContents(els.reportText);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function handleCopy() {
    if (!currentReport) return;

    copyText(currentReport).then(function (ok) {
      els.copyBtn.textContent = ok ? '已复制' : '复制失败，请手动选择';
      if (ok) {
        toast('周报已复制，去粘贴吧');
      } else {
        selectReportText();
        els.reportText.focus();
      }
      setTimeout(function () {
        if (!els.reportModal.hidden) els.copyBtn.textContent = '复制到剪贴板';
      }, 2200);
    });
  }

  /* ---------- 备份 ---------- */

  function exportBackup(fileName, silent) {
    var payload = {
      app: 'shougon-sanhang',
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: state.entries
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName || 'shougon-sanhang-' + todayKey() + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    if (!silent) toast('备份已导出');
  }

  function importBackupFromFile(file) {
    var reader = new FileReader();

    reader.onload = function () {
      var imported;
      var stats = { skipped: 0 };
      try {
        var data = JSON.parse(String(reader.result));
        var raw = data && typeof data === 'object' && data.entries && typeof data.entries === 'object'
          ? data.entries
          : data;
        imported = sanitizeEntries(raw, stats);
      } catch (error) {
        toast('导入失败：不是有效的 JSON 备份');
        return;
      }

      var keys = Object.keys(imported);
      if (!keys.length) {
        toast('导入失败：备份里没有可用的记录');
        return;
      }

      // 导入的是真实数据：先把内存里的示例清掉，也不弹「合并」确认
      if (state.isDemo) {
        state.entries = {};
        state.isDemo = false;
      }

      if (Object.keys(state.entries).length) {
        if (!window.confirm('导入会与现有记录合并，同一天以备份内容为准。继续？')) {
          return;
        }
        exportBackup('shougon-sanhang-before-import-' + todayKey() + '.json', true);
      }

      var added = 0;
      var replaced = 0;
      keys.forEach(function (key) {
        if (state.entries[key]) {
          replaced += 1;
        } else {
          added += 1;
        }
        state.entries[key] = imported[key];
      });

      var saved = persist();
      isEditingToday = false;
      renderAll();
      if (saved) {
        var skippedText = stats.skipped ? ' · 跳过 ' + stats.skipped + ' 条' : '';
        toast('已导入 ' + keys.length + ' 天 · 新增 ' + added + '，覆盖 ' + replaced + skippedText);
      }
    };

    reader.onerror = function () {
      toast('读取文件失败，请重试');
    };

    reader.readAsText(file);
  }

  function handleImportChange() {
    var files = els.importFile.files;
    if (files && files[0]) {
      importBackupFromFile(files[0]);
    }
    els.importFile.value = '';
  }

  /* ---------- 示例数据 ---------- */

  var DEMO_DAYS = [
    {
      progress: ['完成比赛提交页的排版，窄屏也不再溢出', '比赛'],
      blocker: ['导出图片在 Safari 下有白边，还没找到原因', '比赛'],
      next: ['先查 canvas 的 devicePixelRatio 处理', '比赛']
    },
    {
      progress: ['把用户反馈里的 6 条问题整理成清单', '其他'],
      blocker: ['有两条复现不了，手里没有对应设备', '其他'],
      next: ['约同学借一台旧 iPhone 试试', '其他']
    },
    {
      progress: ['刷完概率论第三章，错题抄进本子', '学习'],
      blocker: ['条件概率的题还是会想反', '学习'],
      next: ['重做 5 道错题，再讲给自己听一遍', '学习']
    },
    {
      progress: ['跑步 5 公里，晚上十一点前睡了', '生活'],
      blocker: ['下午喝了咖啡，还是犯困', '生活'],
      next: ['午休二十分钟，不靠咖啡撑', '生活']
    },
    null,
    {
      progress: ['开源项目的第一个 PR 被合并了', '其他'],
      blocker: ['不知道该接着挑哪个 issue', '其他'],
      next: ['从 good first issue 里选一个文档任务', '其他']
    },
    {
      progress: ['给比赛作品补了 60 秒演示脚本', '比赛'],
      blocker: ['录屏时嘴瓢了三次', '比赛'],
      next: ['把开场白缩成三句话再录', '比赛']
    },
    {
      progress: ['整理了这周的时间开销，发现会议占太多', '生活'],
      blocker: ['计划表排得太满，一累就全崩', '生活'],
      next: ['明天只排三件必做的事', '生活']
    },
    {
      progress: ['读完《重构》第四章，做了笔记', '学习'],
      blocker: ['例子里的坏味道我认不全', '学习'],
      next: ['拿自己的旧代码对照找一遍', '学习']
    },
    null,
    {
      progress: ['首页深色模式的对比度调好了', '比赛'],
      blocker: ['浅色模式下按钮有点发灰', '比赛'],
      next: ['把主色再提亮一档试试', '比赛']
    },
    {
      progress: ['去图书馆待了一下午，效率意外地高', '学习'],
      blocker: ['手机总在手边，分心好几次', '学习'],
      next: ['进馆就把手机调成专注模式', '学习']
    },
    {
      progress: ['把冰箱清了，做了顿正经晚饭', '生活'],
      blocker: ['买菜总是买多，最后坏掉', '生活'],
      next: ['列一张三天的菜单再去买', '生活']
    },
    {
      progress: ['比赛报名表填完，队伍也凑齐了', '比赛'],
      blocker: ['队名还没想好，卡了两天', '比赛'],
      next: ['今晚在群里投票定下来', '比赛']
    }
  ];

  function toDemoLine(value) {
    return { text: value[0], tag: TAGS.indexOf(value[1]) >= 0 ? value[1] : null };
  }

  function seedDemo() {
    var today = new Date();
    state.entries = {};

    DEMO_DAYS.forEach(function (sample, offset) {
      if (!sample) return;
      var date = addDays(today, -offset);
      state.entries[dateKey(date)] = {
        progress: toDemoLine(sample.progress),
        blocker: toDemoLine(sample.blocker),
        next: toDemoLine(sample.next),
        updatedAt: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 21, 30).toISOString()
      };
    });

    // 示例数据只放在内存里，不写进本地存储：
    // 用户第一次保存自己的内容时会整体清掉，避免假记录污染真实数据。
    state.isDemo = true;
  }

  function seedDemoIfEmpty() {
    if (Object.keys(state.entries).length > 0) return false;
    var forced = new URLSearchParams(window.location.search).get('demo') === '1';
    seedDemo();
    if (forced) {
      setTimeout(function () {
        toast('已载入 ' + Object.keys(state.entries).length + ' 天示例数据');
      }, 350);
    }
    return true;
  }

  /* ---------- 顶部横幅与次日闭环 ---------- */

  function readIgnoreNextDate() {
    try {
      return localStorage.getItem(IGNORE_NEXT_KEY);
    } catch (error) {
      return null;
    }
  }

  function writeIgnoreNextDate(key) {
    try {
      localStorage.setItem(IGNORE_NEXT_KEY, key);
    } catch (error) {
      /* 存储不可用时忽略：卡片当天不再出现即可，不阻塞使用 */
    }
  }

  // 昨天写了「明天第一步」、今天还没记录，且今天没点过「不做这个」
  function computePendingNextStep() {
    if (state.isDemo) return null;
    var tk = todayKey();
    if (state.entries[tk]) return null;
    if (readIgnoreNextDate() === tk) return null;
    var yKey = dateKey(addDays(new Date(), -1));
    var yesterday = state.entries[yKey];
    if (yesterday && yesterday.next && yesterday.next.text) return yesterday.next.text;
    return null;
  }

  function renderTopBanners() {
    if (els.demoBanner) {
      els.demoBanner.hidden = !state.isDemo;
    }
    if (els.nextCard) {
      var next = nextStepDismissed ? null : computePendingNextStep();
      if (next) {
        if (els.nextCardContent) els.nextCardContent.textContent = next;
        els.nextCard.hidden = false;
      } else {
        els.nextCard.hidden = true;
      }
    }
  }

  function clearDemoAndStart() {
    state.entries = {};
    state.isDemo = false;
    nextStepDismissed = false;
    isEditingToday = false;
    persist();
    renderAll();
    startWriting();
  }

  function applyNextStepToToday() {
    var text = computePendingNextStep();
    if (!text) return;
    // 今天没有记录，表单本来就是可写状态；保险起见同步一次
    isEditingToday = false;
    renderCompose();
    els.progress.value = text;
    nextStepDismissed = true;
    renderTopBanners();
    if (els.compose) {
      els.compose.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    try {
      els.progress.focus({ preventScroll: true });
    } catch (error) {
      els.progress.focus();
    }
  }

  function skipNextStepToday() {
    writeIgnoreNextDate(todayKey());
    nextStepDismissed = true;
    renderTopBanners();
  }

  function closeNextStepCard() {
    nextStepDismissed = true;
    renderTopBanners();
  }

  /* ---------- 首次三步引导 ---------- */

  function readGuideSeen() {
    try {
      return localStorage.getItem(GUIDE_SEEN_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function markGuideSeen() {
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, '1');
    } catch (error) {
      /* 存储不可用时退化为每次访问都显示，不影响主流程 */
    }
  }

  function shouldShowOnboarding() {
    if (readGuideSeen()) return false;
    // 主动看示例（?demo=1）时不打扰
    if (new URLSearchParams(window.location.search).get('demo') === '1') return false;
    return state.isDemo || Object.keys(state.entries).length === 0;
  }

  function renderOnboarding() {
    if (!els.onboardBar) return;
    if (onboardingState === 'closed') {
      els.onboardBar.hidden = true;
      return;
    }
    if (onboardingState !== 'open') {
      if (!shouldShowOnboarding()) {
        els.onboardBar.hidden = true;
        return;
      }
      onboardingState = 'open';
      markGuideSeen();
    }
    els.onboardBar.hidden = false;
  }

  function closeOnboarding() {
    onboardingState = 'closed';
    if (els.onboardBar) els.onboardBar.hidden = true;
  }

  /* ---------- 提示 ---------- */

  function popStamp() {
    if (!els.stamp) return;
    els.stamp.classList.remove('pop');
    void els.stamp.offsetWidth;
    els.stamp.classList.add('pop');
  }

  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('show');
    }, 2800);
  }

  /* ---------- 事件与初始化 ---------- */

  function cacheEls() {
    els = {
      shell: document.querySelector('.shell'),
      storageWarn: document.getElementById('storageWarn'),
      demoBanner: document.getElementById('demoBanner'),
      clearDemoBtn: document.getElementById('clearDemoBtn'),
      nextCard: document.getElementById('nextCard'),
      nextCardContent: document.getElementById('nextCardContent'),
      nextApplyBtn: document.getElementById('nextApplyBtn'),
      nextSkipBtn: document.getElementById('nextSkipBtn'),
      nextCardClose: document.getElementById('nextCardClose'),
      onboardBar: document.getElementById('onboardBar'),
      onboardClose: document.getElementById('onboardClose'),
      onboardKbd: document.getElementById('onboardKbd'),
      todayDate: document.getElementById('todayDate'),
      todayWeekday: document.getElementById('todayWeekday'),
      streak: document.getElementById('streak'),
      streakText: document.getElementById('streakText'),
      statsText: document.getElementById('statsText'),
      guideCard: document.getElementById('guideCard'),
      guideStart: document.getElementById('guideStart'),
      guideDemo: document.getElementById('guideDemo'),
      compose: document.querySelector('.compose'),
      composeHint: document.getElementById('composeHint'),
      entryForm: document.getElementById('entryForm'),
      todaySaved: document.getElementById('todaySaved'),
      todaySavedLines: document.getElementById('todaySavedLines'),
      stamp: document.querySelector('.stamp'),
      fixAfterBtn: document.getElementById('fixAfterBtn'),
      editTodayBtn: document.getElementById('editTodayBtn'),
      progress: document.getElementById('progress'),
      progressTag: document.getElementById('progressTag'),
      blocker: document.getElementById('blocker'),
      blockerTag: document.getElementById('blockerTag'),
      fixToggle: document.getElementById('fixToggle'),
      fixArea: document.getElementById('fixArea'),
      fix: document.getElementById('fix'),
      fixSuggest: document.getElementById('fixSuggest'),
      fixSuggestText: document.getElementById('fixSuggestText'),
      fixSuggestApply: document.getElementById('fixSuggestApply'),
      next: document.getElementById('next'),
      nextTag: document.getElementById('nextTag'),
      formError: document.getElementById('formError'),
      saveLabel: document.getElementById('saveLabel'),
      saveKbd: document.getElementById('saveKbd'),
      reportBtn: document.getElementById('reportBtn'),
      exportBtn: document.getElementById('exportBtn'),
      importBtn: document.getElementById('importBtn'),
      importFile: document.getElementById('importFile'),
      timelineList: document.getElementById('timelineList'),
      timelineMeta: document.getElementById('timelineMeta'),
      reportModal: document.getElementById('reportModal'),
      reportTitle: document.getElementById('reportTitle'),
      reportText: document.getElementById('reportText'),
      reportRange: document.getElementById('reportRange'),
      reportEmpty: document.getElementById('reportEmpty'),
      copyBtn: document.getElementById('copyBtn'),
      downloadBtn: document.getElementById('downloadBtn'),
      shareBtn: document.getElementById('shareBtn'),
      shareModal: document.getElementById('shareModal'),
      shareImage: document.getElementById('shareImage'),
      shareDownloadBtn: document.getElementById('shareDownloadBtn'),
      toast: document.getElementById('toast')
    };
    els.modalPanel = els.reportModal.querySelector('.modal-panel');
    els.sharePanel = els.shareModal.querySelector('.modal-panel');
  }

  function applyModKey() {
    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    var label = isMac ? '⌘+Enter' : 'Ctrl+Enter';
    els.saveKbd.textContent = label;
    if (els.onboardKbd) els.onboardKbd.textContent = label;
  }

  var FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), ' +
    'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trapModalFocus(event, panel) {
    var nodes = Array.prototype.filter.call(
      panel.querySelectorAll(FOCUSABLE),
      function (node) {
        return node.offsetParent !== null;
      }
    );
    if (!nodes.length) return;

    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    var active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  function activeModalPanel() {
    if (els.shareModal && !els.shareModal.hidden) return els.sharePanel;
    if (els.reportModal && !els.reportModal.hidden) return els.modalPanel;
    return null;
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      if (els.shareModal && !els.shareModal.hidden) {
        closeSharePreview();
        return;
      }
      if (!els.reportModal.hidden) {
        closeReport();
        return;
      }
      if (pendingDelete) {
        var deletingKey = pendingDelete;
        pendingDelete = null;
        renderTimeline();
        focusTimelineAction('ask-delete', deletingKey);
        return;
      }
    }

    if (event.key === 'Tab') {
      var panel = activeModalPanel();
      if (panel) {
        trapModalFocus(event, panel);
        return;
      }
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      if (!els.entryForm.hidden) {
        event.preventDefault();
        if (typeof els.entryForm.requestSubmit === 'function') {
          els.entryForm.requestSubmit();
        } else {
          els.entryForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
    }
  }

  function startWriting() {
    if (els.compose) {
      els.compose.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    try {
      els.progress.focus({ preventScroll: true });
    } catch (error) {
      els.progress.focus();
    }
  }

  function loadDemoAndReload() {
    var url = new URL(window.location.href);
    url.searchParams.set('demo', '1');
    window.location.href = url.href;
  }

  function handleRangeClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var button = target.closest('[data-range]');
    if (!button) return;

    var range = button.dataset.range === 'last' ? 'last' : 'this';
    if (range === reportRange) return;

    reportRange = range;
    renderReport();
  }

  function setupViewportOffset() {
    var viewport = window.visualViewport;
    if (!viewport) return;

    function sync() {
      var offset = Math.round(window.innerHeight - viewport.height - viewport.offsetTop);
      if (!isFinite(offset) || offset < 0) offset = 0;
      document.documentElement.style.setProperty('--kb-offset', offset + 'px');
    }

    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    sync();
  }

  function syncFromStorage() {
    // 示例数据是临时的、不落盘，不要用空存储把它覆盖掉
    if (state.isDemo) return;
    var next = sanitizeEntries(readRawEntries());
    if (JSON.stringify(next) === JSON.stringify(state.entries)) return;
    state.entries = next;
    if (pendingDelete && !state.entries[pendingDelete]) pendingDelete = null;
    renderAll();
  }

  function bindEvents() {
    els.entryForm.addEventListener('submit', handleSubmit);
    els.entryForm.addEventListener('input', hideFormError);

    els.editTodayBtn.addEventListener('click', function () {
      var entry = state.entries[todayKey()];
      isEditingToday = true;
      fillForm(entry || null);
      renderCompose();
      els.progress.focus();
    });

    els.fixAfterBtn.addEventListener('click', function () {
      var entry = state.entries[todayKey()];
      if (!entry) return;
      isEditingToday = true;
      fillForm(entry);
      renderCompose();
      setFixExpanded(true);
      els.fix.focus();
    });

    els.fixToggle.addEventListener('click', function () {
      setFixExpanded(els.fixArea.hidden);
    });
    els.blocker.addEventListener('input', scheduleFixSuggestion);
    els.fixSuggestApply.addEventListener('click', applySuggestedFix);

    els.timelineList.addEventListener('click', handleTimelineClick);

    els.reportBtn.addEventListener('click', openReport);
    els.copyBtn.addEventListener('click', handleCopy);
    els.downloadBtn.addEventListener('click', downloadReport);
    els.shareBtn.addEventListener('click', openSharePreview);
    els.shareDownloadBtn.addEventListener('click', downloadShareImage);
    els.reportRange.addEventListener('click', handleRangeClick);

    els.guideStart.addEventListener('click', startWriting);
    els.guideDemo.addEventListener('click', loadDemoAndReload);

    if (els.onboardClose) els.onboardClose.addEventListener('click', closeOnboarding);
    if (els.clearDemoBtn) els.clearDemoBtn.addEventListener('click', clearDemoAndStart);
    if (els.nextApplyBtn) els.nextApplyBtn.addEventListener('click', applyNextStepToToday);
    if (els.nextSkipBtn) els.nextSkipBtn.addEventListener('click', skipNextStepToday);
    if (els.nextCardClose) els.nextCardClose.addEventListener('click', closeNextStepCard);

    els.reportModal.addEventListener('click', function (event) {
      var target = event.target;
      if (target instanceof Element && target.hasAttribute('data-close')) {
        closeReport();
      }
    });

    els.shareModal.addEventListener('click', function (event) {
      var target = event.target;
      if (target instanceof Element && target.hasAttribute('data-share-close')) {
        closeSharePreview();
      }
    });

    els.exportBtn.addEventListener('click', function () {
      exportBackup();
    });
    els.importBtn.addEventListener('click', function () {
      els.importFile.click();
    });
    els.importFile.addEventListener('change', handleImportChange);

    document.addEventListener('keydown', handleKeydown);

    window.addEventListener('storage', function (event) {
      if (!event.key || event.key === STORAGE_KEY) syncFromStorage();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') syncFromStorage();
    });
  }

  function init() {
    cacheEls();
    if (!probeStorage()) showStorageWarn();
    state.entries = sanitizeEntries(readRawEntries());
    bindEvents();
    applyModKey();
    setupViewportOffset();
    seedDemoIfEmpty();
    renderAll();
  }

  init();
})();
