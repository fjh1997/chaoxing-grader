#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignments } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const statusPath = path.join(baseDir, 'report_all_status.json');
const outputPath = path.join(baseDir, 'reports_index.html');

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function chineseNumberToInt(text) {
  const values = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (!text) return 999;
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (values[text.slice(1)] || 0);
  if (text.endsWith('十')) return (values[text[0]] || 0) * 10;
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    return (values[tens] || 1) * 10 + (values[ones] || 0);
  }
  return values[text] || 999;
}

function orderFromTitle(title, fallback) {
  const match = String(title || '').match(/作业([一二三四五六七八九十]+)/);
  const order = chineseNumberToInt(match?.[1] || '');
  return Number.isFinite(order) ? order : fallback;
}

function escapeScriptJson(value) {
  return JSON.stringify(value, null, 2).replace(/<\//g, '<\\/');
}

const status = JSON.parse(await readFile(statusPath, 'utf8'));
const generatedAt = status.generatedAt || new Date().toISOString();
const manifestOrder = new Map(assignments.map((item, index) => [path.basename(item.runDir), index + 1]));

const reports = [];
for (const [index, row] of (status.results || []).entries()) {
  const runDir = path.isAbsolute(row.runDir || '')
    ? row.runDir
    : path.resolve(baseDir, row.runDir || '');
  const mainReport = path.join(runDir, 'review_report.html');
  const advancedReport = path.join(runDir, 'review_report_advanced.html');
  const hasMain = await exists(mainReport);
  const hasAdvanced = await exists(advancedReport);
  if (!hasMain) continue;
  reports.push({
    id: path.basename(runDir),
    title: row.title || path.basename(runDir),
    order: manifestOrder.get(path.basename(runDir)) || orderFromTitle(row.title, index + 1),
    students: row.students || 0,
    submissions: row.submissions || 0,
    drafts: row.drafts || 0,
    confirmed: row.confirmed || 0,
    suspected: row.suspected || 0,
    confirmedPairs: row.confirmedPairs || 0,
    suspectedPairs: row.suspectedPairs || 0,
    advanced: row.advanced || 0,
    bad: row.bad || 0,
    ok: Boolean(row.ok),
    complete: Boolean(row.complete),
    reportHref: toPosix(path.relative(baseDir, mainReport)),
    advancedHref: hasAdvanced ? toPosix(path.relative(baseDir, advancedReport)) : '',
    runDirName: path.basename(runDir),
  });
}

reports.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-Hans-CN'));

const totals = reports.reduce((acc, row) => {
  acc.students += row.students;
  acc.submissions += row.submissions;
  acc.drafts += row.drafts;
  acc.confirmed += row.confirmed;
  acc.suspected += row.suspected;
  acc.confirmedPairs += row.confirmedPairs;
  acc.suspectedPairs += row.suspectedPairs;
  acc.advanced += row.advanced;
  acc.bad += row.bad;
  return acc;
}, {
  students: 0,
  submissions: 0,
  drafts: 0,
  confirmed: 0,
  suspected: 0,
  confirmedPairs: 0,
  suspectedPairs: 0,
  advanced: 0,
  bad: 0,
});

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>超星作业批改报告索引</title>
  <style>
    :root {
      --bg: #f5f7fa;
      --panel: #ffffff;
      --ink: #1b2430;
      --muted: #647184;
      --line: #d9e0e8;
      --line-strong: #b9c4d0;
      --accent: #1769aa;
      --accent-soft: #e8f2fb;
      --ok: #087443;
      --warn: #9a5b00;
      --danger: #b42318;
      --shadow: 0 1px 2px rgba(27, 36, 48, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      height: 100%;
      margin: 0;
    }

    body {
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      letter-spacing: 0;
    }

    .app {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      height: 100vh;
      min-width: 320px;
    }

    .topbar {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      box-shadow: var(--shadow);
      padding: 14px 18px 12px;
    }

    .title-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 12px;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      line-height: 1.25;
    }

    .generated {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .top-actions a {
      align-items: center;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      color: var(--ink);
      display: inline-flex;
      font-size: 13px;
      font-weight: 600;
      min-height: 32px;
      padding: 6px 10px;
      text-decoration: none;
      white-space: nowrap;
    }

    .top-actions a.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(7, minmax(92px, 1fr));
      gap: 8px;
    }

    .metric {
      border: 1px solid var(--line);
      background: #fbfcfd;
      border-radius: 6px;
      min-height: 58px;
      padding: 8px 10px;
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 2px;
    }

    .metric strong {
      display: block;
      font-size: 20px;
      line-height: 1.1;
    }

    .metric.confirmed strong {
      color: var(--danger);
    }

    .metric.suspected strong {
      color: var(--warn);
    }

    .main {
      display: grid;
      grid-template-columns: 390px minmax(0, 1fr);
      min-height: 0;
    }

    .sidebar {
      border-right: 1px solid var(--line);
      background: #fbfcfd;
      min-height: 0;
      overflow: auto;
      padding: 14px;
    }

    .filters {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 128px;
      gap: 8px;
      margin-bottom: 12px;
    }

    input,
    select {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      padding: 7px 9px;
    }

    input:focus,
    select:focus,
    button:focus-visible,
    a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .report-list {
      display: grid;
      gap: 8px;
    }

    .report-button {
      display: block;
      width: 100%;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      padding: 10px;
      text-align: left;
      box-shadow: var(--shadow);
    }

    .report-button:hover {
      border-color: var(--accent);
    }

    .report-button.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .report-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-weight: 700;
    }

    .status-pill {
      flex: 0 0 auto;
      border-radius: 999px;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      padding: 5px 7px;
    }

    .status-pill.ok {
      background: var(--ok);
    }

    .status-pill.warn {
      background: var(--warn);
    }

    .small-metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
    }

    .small-metrics b {
      color: var(--ink);
      display: block;
      font-size: 14px;
      line-height: 1.2;
    }

    .viewer {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: #eef2f6;
    }

    .viewerbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 48px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      padding: 8px 12px;
    }

    .viewer-title {
      min-width: 0;
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .viewer-actions {
      display: flex;
      gap: 8px;
      flex: 0 0 auto;
    }

    .viewer-actions a {
      align-items: center;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      color: var(--ink);
      display: inline-flex;
      font-weight: 600;
      min-height: 32px;
      padding: 6px 10px;
      text-decoration: none;
      white-space: nowrap;
    }

    .viewer-actions a.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }

    .viewer-actions a.disabled {
      color: var(--muted);
      cursor: default;
      opacity: 0.55;
      pointer-events: none;
    }

    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
    }

    .empty {
      border: 1px dashed var(--line-strong);
      border-radius: 6px;
      color: var(--muted);
      padding: 18px;
      text-align: center;
    }

    @media (max-width: 1080px) {
      .summary {
        grid-template-columns: repeat(4, minmax(92px, 1fr));
      }

      .main {
        grid-template-columns: 330px minmax(0, 1fr);
      }
    }

    @media (max-width: 780px) {
      .app {
        height: auto;
        min-height: 100vh;
      }

      .title-row,
      .viewerbar {
        align-items: stretch;
        flex-direction: column;
      }

      .generated {
        white-space: normal;
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .main {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--line);
        max-height: 52vh;
      }

      .viewer {
        min-height: 74vh;
      }

      .viewer-actions {
        flex-wrap: wrap;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="title-row">
        <h1>超星作业批改报告索引</h1>
        <div class="top-actions">
          <a class="primary" href="score_rankings.html">分数排名</a>
          <div class="generated">生成时间：<time id="generatedAt"></time></div>
        </div>
      </div>
      <section class="summary" aria-label="总览">
        <div class="metric"><span>作业</span><strong id="totalReports">0</strong></div>
        <div class="metric"><span>学生</span><strong id="totalStudents">0</strong></div>
        <div class="metric"><span>提交</span><strong id="totalSubmissions">0</strong></div>
        <div class="metric"><span>评分草稿</span><strong id="totalDrafts">0</strong></div>
        <div class="metric confirmed"><span>确认人数</span><strong id="totalConfirmed">0</strong></div>
        <div class="metric suspected"><span>疑似人数</span><strong id="totalSuspected">0</strong></div>
        <div class="metric"><span>异常</span><strong id="totalBad">0</strong></div>
      </section>
    </header>

    <main class="main">
      <aside class="sidebar">
        <div class="filters">
          <input id="searchBox" type="search" placeholder="搜索作业">
          <select id="sortMode" aria-label="排序">
            <option value="order">作业顺序</option>
            <option value="confirmed">确认最多</option>
            <option value="suspected">疑似最多</option>
            <option value="students">人数最多</option>
          </select>
        </div>
        <div id="reportList" class="report-list"></div>
      </aside>

      <section class="viewer" aria-label="报告预览">
        <div class="viewerbar">
          <div id="viewerTitle" class="viewer-title"></div>
          <nav class="viewer-actions" aria-label="报告操作">
            <a id="advancedLink" href="#" target="_blank" rel="noreferrer">高级报告</a>
            <a id="openLink" class="primary" href="#" target="_blank" rel="noreferrer">新窗口打开</a>
          </nav>
        </div>
        <iframe id="reportFrame" title="作业报告"></iframe>
      </section>
    </main>
  </div>

  <script>
    const reports = ${escapeScriptJson(reports)};
    const totals = ${escapeScriptJson(totals)};
    const generatedAt = ${escapeScriptJson(generatedAt)};

    const byId = new Map(reports.map(report => [report.id, report]));
    const list = document.getElementById('reportList');
    const frame = document.getElementById('reportFrame');
    const viewerTitle = document.getElementById('viewerTitle');
    const openLink = document.getElementById('openLink');
    const advancedLink = document.getElementById('advancedLink');
    const searchBox = document.getElementById('searchBox');
    const sortMode = document.getElementById('sortMode');
    let activeId = '';

    function formatNumber(value) {
      return Number(value || 0).toLocaleString('zh-CN');
    }

    function setText(id, value) {
      document.getElementById(id).textContent = formatNumber(value);
    }

    function sortedReports() {
      const query = searchBox.value.trim().toLowerCase();
      const filtered = reports.filter(report => {
        const haystack = [report.title, report.runDirName].join(' ').toLowerCase();
        return !query || haystack.includes(query);
      });
      const mode = sortMode.value;
      filtered.sort((a, b) => {
        if (mode === 'confirmed') return b.confirmed - a.confirmed || a.order - b.order;
        if (mode === 'suspected') return b.suspected - a.suspected || a.order - b.order;
        if (mode === 'students') return b.students - a.students || a.order - b.order;
        return a.order - b.order || a.title.localeCompare(b.title, 'zh-Hans-CN');
      });
      return filtered;
    }

    function renderList() {
      const rows = sortedReports();
      list.textContent = '';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '没有匹配的报告';
        list.appendChild(empty);
        return;
      }
      for (const report of rows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'report-button' + (report.id === activeId ? ' active' : '');
        button.dataset.id = report.id;
        button.innerHTML = \`
          <div class="report-title">
            <span>\${report.title}</span>
            <span class="status-pill \${report.complete && report.ok ? 'ok' : 'warn'}">\${report.complete && report.ok ? 'OK' : '检查'}</span>
          </div>
          <div class="small-metrics">
            <span><b>\${formatNumber(report.students)}</b>学生</span>
            <span><b>\${formatNumber(report.drafts)}</b>草稿</span>
            <span title="pair 明细：\${formatNumber(report.confirmedPairs)} 条"><b>\${formatNumber(report.confirmed)}</b>确认人数</span>
            <span title="pair 明细：\${formatNumber(report.suspectedPairs)} 条"><b>\${formatNumber(report.suspected)}</b>疑似人数</span>
          </div>
        \`;
        button.addEventListener('click', () => loadReport(report.id, true));
        list.appendChild(button);
      }
    }

    function loadReport(id, updateHash) {
      const report = byId.get(id) || reports[0];
      if (!report) return;
      activeId = report.id;
      viewerTitle.textContent = report.title;
      frame.src = report.reportHref;
      openLink.href = report.reportHref;
      advancedLink.href = report.advancedHref || '#';
      advancedLink.classList.toggle('disabled', !report.advancedHref);
      advancedLink.setAttribute('aria-disabled', report.advancedHref ? 'false' : 'true');
      if (updateHash) {
        history.replaceState(null, '', '#' + encodeURIComponent(report.id));
      }
      renderList();
    }

    document.getElementById('generatedAt').textContent = new Date(generatedAt).toLocaleString('zh-CN');
    document.getElementById('totalReports').textContent = formatNumber(reports.length);
    setText('totalStudents', totals.students);
    setText('totalSubmissions', totals.submissions);
    setText('totalDrafts', totals.drafts);
    setText('totalConfirmed', totals.confirmed);
    setText('totalSuspected', totals.suspected);
    setText('totalBad', totals.bad);

    searchBox.addEventListener('input', renderList);
    sortMode.addEventListener('change', renderList);

    const hashId = decodeURIComponent(location.hash.replace(/^#/, ''));
    renderList();
    loadReport(byId.has(hashId) ? hashId : reports[0]?.id, false);
  </script>
</body>
</html>
`;

await writeFile(outputPath, html, 'utf8');
console.log(`Wrote ${outputPath}`);
