(function () {
  'use strict';

  var STORAGE_KEY = 'shougon-sanhang.v1';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TAGS = ['比赛', '学习', '生活', '其他'];
  var TAG_CLASS = { 比赛: 'tag-match', 学习: 'tag-study', 生活: 'tag-life', 其他: 'tag-other' };
  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var FIELDS = [
    { key: 'progress', label: '推进', reportLabel: '推进' },
    { key: 'blocker', label: '卡点', reportLabel: '卡点' },
    { key: 'next', label: '明天第一步', reportLabel: '明天第一步' }
  ];

  var state = { version: 1, entries: {} };
  var els = {};
  var isEditingToday = false;
  var pendingDelete = null;
  var collapsedWeeks = new Set();
  var currentReport = '';
  var toastTimer = null;
  var lastFocused = null;

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

  function sanitizeEntries(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    Object.keys(raw).forEach(function (key) {
      if (!DATE_RE.test(key)) return;
      var day = raw[key];
      if (!day || typeof day !== 'object' || Array.isArray(day)) return;
      var entry = {
        progress: readLine(day.progress),
        blocker: readLine(day.blocker),
        next: readLine(day.next),
        updatedAt: typeof day.updatedAt === 'string' ? day.updatedAt : null
      };
      if (entry.progress.text || entry.blocker.text || entry.next.text) {
        out[key] = entry;
      }
    });
    return out;
  }

  function readRawEntries() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      if (parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
      return parsed;
    } catch (error) {
      console.warn('读取本地记录失败', error);
      return {};
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: state.entries }));
    } catch (error) {
      console.warn('写入本地记录失败', error);
      toast('保存失败：浏览器本地存储不可用');
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

  /* ---------- 渲染：头部与今日 ---------- */

  function renderHeader() {
    var now = new Date();
    els.todayDate.textContent = fullDate(now);
    els.todayWeekday.textContent = weekdayName(now);

    var streak = computeStreak();
    els.streakText.textContent = '连续打卡 ' + streak + ' 天';
    els.streak.classList.toggle('is-zero', streak === 0);
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

    if (showSaved) {
      els.composeHint.textContent = '今天已收工，想修改就点编辑。';
      renderSavedLines(entry);
    } else if (entry) {
      els.composeHint.textContent = '正在编辑今天的记录，保存后会覆盖。';
    } else {
      els.composeHint.textContent = '写完三行就算收工，不追求完美。';
    }
  }

  function fillForm(entry) {
    FIELDS.forEach(function (field) {
      var line = entry ? entry[field.key] : null;
      els[field.key].value = line ? line.text : '';
      var tagSelect = els[field.key + 'Tag'];
      tagSelect.value = line && line.tag ? line.tag : '';
    });
    hideFormError();
  }

  function clearForm() {
    fillForm(null);
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
    box.appendChild(el('p', 'empty-title', '还没有写下一行'));
    box.appendChild(el('p', 'empty-text', '今晚从最简单的一句开始：今天推进了什么？哪怕只是「把需求读完了」。'));
    var hint = el('p', 'empty-hint');
    hint.appendChild(document.createTextNode('想先看看成品？在网址后加上 '));
    hint.appendChild(el('code', '', '?demo=1'));
    hint.appendChild(document.createTextNode(' 回车，会载入两周示例记录。'));
    box.appendChild(hint);
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

    if (!hasAny) {
      showFormError('至少写一行再收工，哪怕只有半句。');
      els.progress.focus();
      return;
    }

    hideFormError();
    state.entries[key] = entry;
    persist();
    isEditingToday = false;
    renderAll();
    toast('已保存 · 连续打卡 ' + computeStreak() + ' 天');
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

    persist();
    renderAll();
    toast('已删除 ' + shortDate(date) + ' 的记录');
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
    } else if (action === 'cancel-delete') {
      pendingDelete = null;
      renderTimeline();
    } else if (action === 'confirm-delete' && key) {
      deleteEntry(key);
    }
  }

  /* ---------- 周报 ---------- */

  function buildWeeklyReport() {
    var now = new Date();
    var weekStart = startOfWeek(now);
    var days = [];

    for (var i = 0; i < 7; i += 1) {
      var date = addDays(weekStart, i);
      var key = dateKey(date);
      if (state.entries[key]) {
        days.push({ date: date, entry: state.entries[key] });
      }
    }

    if (!days.length) return '';

    var weekEnd = addDays(weekStart, 6);
    var out = [];

    out.push('# 收工三行 · 周报');
    out.push('');
    out.push(fullDate(weekStart) + ' – ' + shortDate(weekEnd) + ' ｜ 本周记录 ' + days.length + ' 天');
    out.push('');

    days.forEach(function (item) {
      out.push('## ' + shortDate(item.date) + ' ' + weekdayName(item.date));
      out.push('');
      FIELDS.forEach(function (field) {
        var line = item.entry[field.key];
        if (!line || !line.text) return;
        var tag = line.tag ? '（' + line.tag + '）' : '';
        out.push('- **' + field.reportLabel + '**：' + line.text + tag);
      });
      out.push('');
    });

    var blockers = days.filter(function (item) {
      return item.entry.blocker && item.entry.blocker.text;
    });

    out.push('## 本周卡点');
    out.push('');
    if (blockers.length) {
      blockers.forEach(function (item) {
        var tag = item.entry.blocker.tag ? '（' + item.entry.blocker.tag + '）' : '';
        out.push('- **' + shortDate(item.date) + '**：' + item.entry.blocker.text + tag);
      });
    } else {
      out.push('- 本周没有记录卡点。');
    }
    out.push('');
    out.push('---');
    out.push('');
    out.push('由「收工三行」自动生成');

    return out.join('\n');
  }

  function openReport() {
    var report = buildWeeklyReport();
    if (!report) {
      toast('本周还没有记录，先写下今天的三行吧');
      return;
    }

    currentReport = report;
    els.reportText.textContent = report;
    els.copyBtn.textContent = '复制到剪贴板';
    lastFocused = document.activeElement;

    els.reportModal.hidden = false;
    document.body.classList.add('modal-open');
    els.modalPanel.focus();
  }

  function closeReport() {
    if (els.reportModal.hidden) return;
    els.reportModal.hidden = true;
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

  function exportBackup() {
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
    link.download = 'shougon-sanhang-' + todayKey() + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    toast('备份已导出');
  }

  function importBackupFromFile(file) {
    var reader = new FileReader();

    reader.onload = function () {
      var imported;
      try {
        var data = JSON.parse(String(reader.result));
        var raw = data && typeof data === 'object' && data.entries && typeof data.entries === 'object'
          ? data.entries
          : data;
        imported = sanitizeEntries(raw);
      } catch (error) {
        toast('导入失败：不是有效的 JSON 备份');
        return;
      }

      var keys = Object.keys(imported);
      if (!keys.length) {
        toast('导入失败：备份里没有可用的记录');
        return;
      }

      if (Object.keys(state.entries).length &&
          !window.confirm('导入会与现有记录合并，同一天以备份内容为准。继续？')) {
        return;
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

      persist();
      isEditingToday = false;
      renderAll();
      toast('已导入 ' + keys.length + ' 天 · 新增 ' + added + '，覆盖 ' + replaced);
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

  function handleDemo() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('demo') !== '1') return;
    if (Object.keys(state.entries).length) return;

    var today = new Date();
    var count = 0;

    DEMO_DAYS.forEach(function (sample, offset) {
      if (!sample) return;
      var date = addDays(today, -offset);
      state.entries[dateKey(date)] = {
        progress: toDemoLine(sample.progress),
        blocker: toDemoLine(sample.blocker),
        next: toDemoLine(sample.next),
        updatedAt: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 21, 30).toISOString()
      };
      count += 1;
    });

    persist();
    setTimeout(function () {
      toast('已载入 ' + count + ' 天示例数据');
    }, 350);
  }

  /* ---------- 提示 ---------- */

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
      todayDate: document.getElementById('todayDate'),
      todayWeekday: document.getElementById('todayWeekday'),
      streak: document.getElementById('streak'),
      streakText: document.getElementById('streakText'),
      composeHint: document.getElementById('composeHint'),
      entryForm: document.getElementById('entryForm'),
      todaySaved: document.getElementById('todaySaved'),
      todaySavedLines: document.getElementById('todaySavedLines'),
      editTodayBtn: document.getElementById('editTodayBtn'),
      progress: document.getElementById('progress'),
      progressTag: document.getElementById('progressTag'),
      blocker: document.getElementById('blocker'),
      blockerTag: document.getElementById('blockerTag'),
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
      reportText: document.getElementById('reportText'),
      copyBtn: document.getElementById('copyBtn'),
      toast: document.getElementById('toast')
    };
    els.modalPanel = els.reportModal.querySelector('.modal-panel');
  }

  function applyModKey() {
    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    els.saveKbd.textContent = isMac ? '⌘ ↵' : 'Ctrl ↵';
  }

  function handleKeydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      if (!els.entryForm.hidden) {
        event.preventDefault();
        if (typeof els.entryForm.requestSubmit === 'function') {
          els.entryForm.requestSubmit();
        } else {
          els.entryForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      }
      return;
    }

    if (event.key === 'Escape' && !els.reportModal.hidden) {
      closeReport();
    }
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

    els.timelineList.addEventListener('click', handleTimelineClick);

    els.reportBtn.addEventListener('click', openReport);
    els.copyBtn.addEventListener('click', handleCopy);

    els.reportModal.addEventListener('click', function (event) {
      var target = event.target;
      if (target instanceof Element && target.hasAttribute('data-close')) {
        closeReport();
      }
    });

    els.exportBtn.addEventListener('click', exportBackup);
    els.importBtn.addEventListener('click', function () {
      els.importFile.click();
    });
    els.importFile.addEventListener('change', handleImportChange);

    document.addEventListener('keydown', handleKeydown);
  }

  function init() {
    cacheEls();
    state.entries = sanitizeEntries(readRawEntries());
    bindEvents();
    applyModKey();
    handleDemo();
    renderAll();
  }

  init();
})();
