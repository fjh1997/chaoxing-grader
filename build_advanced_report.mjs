#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const runDir = path.resolve(process.argv[2] || 'runs/example');
const replaceMain = process.argv.includes('--replace-main');

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function attr(value) {
  return esc(value).replace(/`/g, '&#96;');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

async function loadSubmissions(dir) {
  const submissionsDir = path.join(dir, 'submissions');
  const names = (await readdir(submissionsDir)).filter(name => name.endsWith('.json')).sort();
  const rows = [];
  for (const name of names) {
    rows.push(await readJson(path.join(submissionsDir, name)));
  }
  return rows;
}

async function applyLocalVisionOverrides(dir, submissions) {
  const rows = await readJson(path.join(dir, 'local_vision_overrides.json'), []);
  const overrides = new Map((Array.isArray(rows) ? rows : [])
    .filter(row => row?.workAnswerId)
    .map(row => [String(row.workAnswerId), row]));
  if (!overrides.size) return 0;
  let count = 0;
  for (const submission of submissions) {
    const override = overrides.get(String(submission.workAnswerId));
    if (!override) continue;
    submission.vision = {
      ...(submission.vision || {}),
      ...override,
      model: override.model || 'local-evidence-review',
      risk: override.risk || 'local-evidence-review',
    };
    count++;
  }
  return count;
}

function scoreNumber(row) {
  const n = Number(row?.draftScore);
  return Number.isFinite(n) ? n : 0;
}

function isPlagiarismZero(row) {
  const text = [row?.risk, row?.basis, row?.draftComment].join('\n');
  return scoreNumber(row) === 0 && /advanced-confirmed|高级相似检测|雷同|后续雷同|首个提交/.test(text);
}

function evidenceLabel(row) {
  const exact = [];
  if (row.exactObject) exact.push('同一上传对象');
  if (row.exactFile) exact.push('同一文件');
  if (exact.length) return exact.join(' / ');
  return row.decisionReason || '局部特征 + 核心证据';
}

function metric(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function verdictText(value) {
  if (value === 'confirmed') return '确认雷同';
  if (value === 'suspected') return '疑似，未自动置零';
  return value || '';
}

function pairStudentIds(pair) {
  return [String(pair.aWorkAnswerId), String(pair.bWorkAnswerId)].filter(Boolean);
}

function evidenceGroupKeys(pair) {
  const exact = String(pair.exactShared || '')
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean)
    .sort();
  if (exact.length) return exact.map(item => `exact:${item}`);

  const siftFiles = [pair.siftAFile, pair.siftBFile].filter(Boolean).map(String).sort();
  const akazeFiles = [pair.akazeAFile, pair.akazeBFile].filter(Boolean).map(String).sort();
  if (siftFiles.length === 2 && Number(pair.siftInliers || 0) > 0) return [`sift:${siftFiles.join('|')}`];
  if (akazeFiles.length === 2 && Number(pair.akazeInliers || 0) > 0) return [`akaze:${akazeFiles.join('|')}`];
  return [`pair:${pair.aWorkAnswerId}|${pair.bWorkAnswerId}`];
}

function buildSimilarityGroups(pairs, verdict) {
  const selected = pairs.filter(row => row.verdict === verdict);
  const buckets = new Map();
  for (const pair of selected) {
    const ids = pairStudentIds(pair);
    if (ids.length < 2) continue;
    for (const key of evidenceGroupKeys(pair)) {
      if (!buckets.has(key)) buckets.set(key, { key, ids: new Set(), pairs: [] });
      const bucket = buckets.get(key);
      ids.forEach(id => bucket.ids.add(id));
      bucket.pairs.push(pair);
    }
  }
  return [...buckets.values()].filter(group => group.ids.size >= 2).map(group => ({
    key: group.key,
    ids: [...group.ids],
    pairs: group.pairs,
  }));
}

function similarityStats(pairs) {
  const confirmedGroups = buildSimilarityGroups(pairs, 'confirmed');
  const suspectedGroups = buildSimilarityGroups(pairs, 'suspected');
  const countPeople = groups => {
    const ids = new Set();
    for (const group of groups) group.ids.forEach(id => ids.add(String(id)));
    return ids.size;
  };
  return {
    confirmedGroups,
    suspectedGroups,
    confirmedPeople: countPeople(confirmedGroups),
    suspectedPeople: countPeople(suspectedGroups),
    confirmedPairRows: pairs.filter(row => row.verdict === 'confirmed').length,
    suspectedPairRows: pairs.filter(row => row.verdict === 'suspected').length,
  };
}

function buildSummary(drafts, submissions, pairs) {
  const active = drafts.filter(row => !row.skip);
  const skipped = drafts.length - active.length;
  const byScore = new Map();
  const byClass = new Map();
  const stats = similarityStats(pairs);
  for (const row of active) {
    const score = String(row.draftScore ?? '');
    byScore.set(score, (byScore.get(score) || 0) + 1);
    if (!byClass.has(row.className)) byClass.set(row.className, { total: 0, zero: 0, plagiarismZero: 0 });
    const item = byClass.get(row.className);
    item.total += 1;
    if (scoreNumber(row) === 0) item.zero += 1;
    if (isPlagiarismZero(row)) item.plagiarismZero += 1;
  }
  return {
    active,
    skipped,
    ...stats,
    plagiarismZeros: active.filter(isPlagiarismZero),
    contentZeros: active.filter(row => scoreNumber(row) === 0 && !isPlagiarismZero(row)),
    scoreText: [...byScore.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([score, count]) => `${score}: ${count}`)
      .join(' / '),
    classRows: [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN')),
    submissionCount: submissions.length,
  };
}

function renderClassTable(classRows) {
  return `
    <table>
      <thead><tr><th>班级</th><th>待批草稿</th><th>0 分</th><th>雷同后交 0 分</th></tr></thead>
      <tbody>${classRows.map(([name, item]) => `
        <tr>
          <td>${esc(name)}</td>
          <td>${item.total}</td>
          <td>${item.zero}</td>
          <td>${item.plagiarismZero}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function renderZeroTable(rows) {
  if (!rows.length) return '<p class="empty">无。</p>';
  return `
    <table>
      <thead><tr><th>学生</th><th>班级</th><th>分数</th><th>依据</th><th>评语</th></tr></thead>
      <tbody>${rows.map(row => `
        <tr>
          <td>${esc(row.name)} <span class="muted">${esc(row.studentNo)}</span></td>
          <td>${esc(row.className)}</td>
          <td><span class="score-pill zero">${esc(row.draftScore)}</span></td>
          <td>${esc(row.basis || row.risk || '')}</td>
          <td>${esc(row.draftComment || '')}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function renderPairTable(rows) {
  if (!rows.length) return '<p class="empty">无高级相似记录。</p>';
  const sorted = rows.slice().sort((a, b) => {
    const order = { confirmed: 0, suspected: 1 };
    return (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9)
      || Number(Boolean(b.exactFile || b.exactObject)) - Number(Boolean(a.exactFile || a.exactObject))
      || Number(b.evidenceSimilarity || 0) - Number(a.evidenceSimilarity || 0)
      || Number(b.siftInliers || 0) + Number(b.akazeInliers || 0) - Number(a.siftInliers || 0) - Number(a.akazeInliers || 0);
  });
  return `
    <table>
      <thead>
        <tr>
          <th>判定</th><th>学生 A</th><th>学生 B</th><th>依据</th>
          <th>哈希</th><th>SIFT</th><th>AKAZE</th><th>核心证据</th><th>共享证据</th>
        </tr>
      </thead>
      <tbody>${sorted.map(row => `
        <tr class="${row.verdict === 'confirmed' ? 'confirmed' : 'suspected'}">
          <td><span class="tag ${attr(row.verdict)}">${esc(verdictText(row.verdict))}</span></td>
          <td>${esc(row.aClass)}<br><strong>${esc(row.aName)}</strong> <span class="muted">${esc(row.aStudentNo)}</span><br><span class="muted">${esc(row.aSubmitTime)}</span></td>
          <td>${esc(row.bClass)}<br><strong>${esc(row.bName)}</strong> <span class="muted">${esc(row.bStudentNo)}</span><br><span class="muted">${esc(row.bSubmitTime)}</span></td>
          <td>${esc(evidenceLabel(row))}</td>
          <td>${esc(metric(row.imageHashSimilarity))}</td>
          <td>${esc(row.siftInliers ?? '')} / ${esc(metric(row.siftRatio))}<br><span class="muted">覆盖 ${esc(metric(row.siftCoverage))}</span></td>
          <td>${esc(row.akazeInliers ?? '')} / ${esc(metric(row.akazeRatio))}<br><span class="muted">覆盖 ${esc(metric(row.akazeCoverage))}</span></td>
          <td>${esc(metric(row.evidenceSimilarity))}</td>
          <td>${esc(row.sharedEvidence || '')}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function pairLine(pair) {
  const metrics = [
    `哈希 ${metric(pair.imageHashSimilarity) || '0'}`,
    `SIFT ${pair.siftInliers ?? ''}/${metric(pair.siftRatio)}${pair.siftAImage ? ` 图${pair.siftAImage}-图${pair.siftBImage}` : ''}`,
    `AKAZE ${pair.akazeInliers ?? ''}/${metric(pair.akazeRatio)}${pair.akazeAImage ? ` 图${pair.akazeAImage}-图${pair.akazeBImage}` : ''}`,
    `核心证据 ${metric(pair.evidenceSimilarity) || '0'}`,
  ].join('，');
  const shared = pair.sharedEvidence ? `；共享证据：${pair.sharedEvidence}` : '';
  return `${pair.aName} ↔ ${pair.bName}：${evidenceLabel(pair)}，${metrics}${shared}`;
}

function pairStrength(pair) {
  return Number(Boolean(pair.exactObject || pair.exactFile)) * 100000
    + Number(pair.evidenceSimilarity || 0) * 10000
    + Number(pair.siftInliers || 0)
    + Number(pair.akazeInliers || 0);
}

function renderGroupEvidence(group) {
  const maxEvidence = 8;
  const sorted = group.pairs.slice().sort((a, b) => pairStrength(b) - pairStrength(a));
  const shown = sorted.slice(0, maxEvidence).map(pair => `<li>${esc(pairLine(pair))}</li>`).join('');
  const omitted = sorted.length > maxEvidence
    ? `<li class="muted">其余 ${sorted.length - maxEvidence} 条 pair 证据已折叠，完整明细见 advanced_similarity.csv。</li>`
    : '';
  return `<ul class="pair-evidence">${shown}${omitted}</ul>`;
}

function highlightedFilesFor(id, pairs) {
  const key = String(id);
  const files = new Set();
  for (const pair of pairs) {
    if (String(pair.aWorkAnswerId) === key) {
      if (pair.siftAFile) files.add(pair.siftAFile);
      if (pair.akazeAFile) files.add(pair.akazeAFile);
    }
    if (String(pair.bWorkAnswerId) === key) {
      if (pair.siftBFile) files.add(pair.siftBFile);
      if (pair.akazeBFile) files.add(pair.akazeBFile);
    }
  }
  return files;
}

function renderStudentCompare(id, byId, draftById, pairs = []) {
  const sub = byId.get(String(id));
  const draft = draftById.get(String(id));
  const assets = (sub?.assets || []).filter(asset => asset.ok && asset.file);
  const highlighted = highlightedFilesFor(id, pairs);
  const images = assets.map((asset, index) => `
    <a class="${highlighted.has(asset.file) ? 'hit' : ''}" href="${attr(asset.file)}" target="_blank" title="${attr(asset.objectId || asset.sha256 || '')}">
      ${highlighted.has(asset.file) ? '<span class="hit-label">算法命中</span>' : ''}
      <img loading="lazy" src="${attr(asset.file)}" alt="${attr(sub?.name || draft?.name || id)} 第 ${index + 1} 张截图">
    </a>`).join('');
  return `
    <article class="compare-student">
      <div class="compare-student-head">
        <div>
          <h3>${esc(sub?.name || draft?.name || id)} <span>${esc(sub?.studentNo || draft?.studentNo || '')}</span></h3>
          <p class="muted">${esc(sub?.className || draft?.className || '')} · ${esc(sub?.status || draft?.status || '')} · ${esc(sub?.submitTime || '')}</p>
        </div>
        <div class="mini-score">${esc(draft?.draftScore ?? sub?.existingScore ?? '')}</div>
      </div>
      <div class="compare-images">${images || '<span class="empty">无图片</span>'}</div>
      <p class="links"><a href="${attr(draft?.reviewUrl || sub?.reviewUrl || '')}" target="_blank">打开批阅页</a></p>
    </article>`;
}

function renderSimilarityComparison(pairs, byId, draftById, verdict) {
  const groups = buildSimilarityGroups(pairs, verdict);
  if (!groups.length) return '<p class="empty">无。</p>';
  const title = verdict === 'confirmed' ? '确认雷同' : '疑似雷同';
  const sortedGroups = groups.slice().sort((a, b) =>
    b.ids.length - a.ids.length
    || b.pairs.length - a.pairs.length
    || pairStrength(b.pairs[0] || {}) - pairStrength(a.pairs[0] || {})
  );
  return sortedGroups.map((group, index) => {
    const orderedIds = group.ids.slice().sort((a, b) => {
      const sa = byId.get(String(a));
      const sb = byId.get(String(b));
      const ta = Date.parse(`2026-${String(sa?.submitTime || '').replace(' ', 'T')}`) || 0;
      const tb = Date.parse(`2026-${String(sb?.submitTime || '').replace(' ', 'T')}`) || 0;
      return ta - tb || String(sa?.studentNo || a).localeCompare(String(sb?.studentNo || b), 'zh-Hans-CN');
    });
    const names = orderedIds.map(id => {
      const sub = byId.get(String(id));
      const draft = draftById.get(String(id));
      return `${sub?.name || draft?.name || id}(${sub?.studentNo || draft?.studentNo || ''})`;
    }).join(' / ');
    return `
      <section class="compare-group ${attr(verdict)}">
        <div class="compare-head">
          <div>
            <h3>${title}组 ${index + 1}：${group.ids.length} 人</h3>
            <p class="group-members">${esc(names)}</p>
            ${renderGroupEvidence(group)}
          </div>
          <span class="tag ${attr(verdict)}">${esc(verdictText(verdict))}</span>
        </div>
        <div class="compare-grid">${orderedIds.map(id => renderStudentCompare(id, byId, draftById, group.pairs)).join('')}</div>
      </section>`;
  }).join('\n');
}

function renderCards(rows, byId) {
  const sortedRows = rows.slice().sort((a, b) => {
    const ap = Number(isPlagiarismZero(a));
    const bp = Number(isPlagiarismZero(b));
    return bp - ap
      || Number(Boolean(b.skip)) - Number(Boolean(a.skip))
      || scoreNumber(a) - scoreNumber(b)
      || String(a.className).localeCompare(String(b.className), 'zh-Hans-CN')
      || String(a.studentNo).localeCompare(String(b.studentNo));
  });
  return sortedRows.map(row => {
    const sub = byId.get(String(row.workAnswerId));
    const vision = sub?.vision;
    const assets = (sub?.assets || []).filter(asset => asset.ok && asset.file);
    const images = assets.map(asset => `
      <a href="${attr(asset.file)}" target="_blank" title="${attr(asset.objectId || asset.sha256 || '')}">
        <img loading="lazy" src="${attr(asset.file)}" alt="${attr(row.name)} 作业截图">
      </a>`).join('');
    const cls = [
      'card',
      row.skip ? 'graded' : '',
      isPlagiarismZero(row) ? 'plagiarism' : '',
      scoreNumber(row) === 0 && !isPlagiarismZero(row) ? 'zero-card' : '',
      row.risk ? 'risk' : '',
    ].filter(Boolean).join(' ');
    return `
      <section class="${cls}">
        <div class="card-head">
          <div>
            <h3>${esc(row.name)} <span>${esc(row.studentNo)}</span></h3>
            <p class="muted">${esc(row.className)} · ${esc(row.status)}${row.skip ? ' · 已批判例' : ''} · ${esc(sub?.submitTime || '')} · ${assets.length} 张图</p>
          </div>
          <div class="score-box">${esc(row.draftScore)}</div>
        </div>
        ${row.risk ? `<div class="riskline">${esc(row.risk)}</div>` : ''}
        ${vision ? `
          <div class="vision">
            <span>内容 ${esc(vision.contentScore ?? '')}/40</span>
            <span>证据 ${esc(vision.evidenceScore ?? '')}/40</span>
            <span>排版 ${esc(vision.layoutScore ?? '')}/20</span>
          </div>
          ${vision.summary ? `<p class="summary-text">${esc(vision.summary)}</p>` : ''}` : ''}
        <p class="comment">${esc(row.draftComment || '')}</p>
        <p class="basis">${esc(row.basis || '')}</p>
        <div class="images">${images || '<span class="empty">无图片</span>'}</div>
        <p class="links"><a href="${attr(row.reviewUrl || sub?.reviewUrl || '')}" target="_blank">打开超星批阅页</a></p>
      </section>`;
  }).join('\n') || '<p class="empty">无。</p>';
}

function renderHtml({ drafts, submissions, pairs, metadata }) {
  const byId = new Map(submissions.map(row => [String(row.workAnswerId), row]));
  const draftById = new Map(drafts.map(row => [String(row.workAnswerId), row]));
  const summary = buildSummary(drafts, submissions, pairs);
  const pendingDrafts = drafts.filter(row => !row.skip);
  const skippedDrafts = drafts.filter(row => row.skip);
  const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const reportTitle = `${metadata?.selectedAssignment?.title || metadata?.title || '课程作业'} 批改复核报告`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(reportTitle)}</title>
<style>
  :root {
    --text: #172033;
    --muted: #667085;
    --line: #d9dee8;
    --panel: #ffffff;
    --bg: #f4f6f9;
    --danger: #b42318;
    --danger-bg: #fff1f0;
    --warn: #9a6700;
    --warn-bg: #fff8db;
    --ok: #067647;
    --ok-bg: #edfcf2;
    --ink: #1d2939;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--text); background: var(--bg); }
  header { position: sticky; top: 0; z-index: 2; background: #fff; border-bottom: 1px solid var(--line); padding: 18px 28px; }
  h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: 0; }
  h2 { margin: 26px 0 12px; font-size: 18px; letter-spacing: 0; }
  h3 { margin: 0; font-size: 17px; letter-spacing: 0; }
  h3 span { color: var(--muted); font-size: 12px; font-weight: 500; }
  p { margin: 6px 0; }
  a { color: #175cd3; text-decoration: none; }
  a:hover { text-decoration: underline; }
  main { padding: 22px 28px 44px; }
  .summary { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 13px; }
  .chip { display: inline-flex; align-items: center; min-height: 28px; padding: 4px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); }
  .chip.strong { border-color: #fda29b; background: var(--danger-bg); color: var(--danger); font-weight: 700; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 760px; }
  th, td { border-bottom: 1px solid #eaecf0; padding: 9px 10px; text-align: left; font-size: 13px; line-height: 1.45; vertical-align: top; }
  th { background: #f8fafc; color: #344054; font-weight: 700; }
  tr:last-child td { border-bottom: 0; }
  tr.confirmed td { background: #fffafa; }
  tr.suspected td { background: #fffdf5; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 14px; align-items: start; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
  .card.graded { border-color: #b8c0cc; box-shadow: inset 4px 0 0 #98a2b3; }
  .card.plagiarism { border-color: #f04438; box-shadow: inset 4px 0 0 #f04438; }
  .card.zero-card { border-color: #98a2b3; box-shadow: inset 4px 0 0 #667085; }
  .card-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  .score-box { min-width: 50px; height: 40px; border-radius: 6px; display: grid; place-items: center; background: var(--ink); color: #fff; font-size: 21px; font-weight: 800; }
  .score-pill { display: inline-flex; min-width: 34px; justify-content: center; padding: 2px 7px; border-radius: 6px; background: var(--ink); color: #fff; font-weight: 700; }
  .score-pill.zero { background: var(--danger); }
  .muted { color: var(--muted); }
  .empty { color: #98a2b3; font-size: 13px; }
  .riskline { margin: 10px 0 8px; padding: 7px 9px; border-radius: 6px; background: var(--danger-bg); color: var(--danger); font-size: 13px; font-weight: 700; }
  .vision { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px; }
  .vision span { padding: 5px 8px; border-radius: 6px; background: var(--ok-bg); color: var(--ok); font-size: 12px; font-weight: 700; }
  .summary-text { color: #344054; font-size: 13px; line-height: 1.5; }
  .comment { line-height: 1.58; font-size: 14px; }
  .basis { color: var(--muted); font-size: 12px; line-height: 1.5; }
  .images { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; margin-top: 11px; }
  .images a { display: block; background: #f2f4f7; border: 1px solid #eaecf0; border-radius: 6px; overflow: hidden; aspect-ratio: 1.18; }
  .images img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .links { margin-top: 10px; font-size: 13px; }
  .tag { display: inline-flex; padding: 3px 7px; border-radius: 6px; font-size: 12px; font-weight: 700; white-space: nowrap; }
  .tag.confirmed { background: var(--danger-bg); color: var(--danger); }
  .tag.suspected { background: var(--warn-bg); color: var(--warn); }
  .compare-list { display: grid; gap: 14px; }
  .compare-group { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
  .compare-group.confirmed { border-color: #fda29b; box-shadow: inset 4px 0 0 #f04438; }
  .compare-group.suspected { border-color: #f6d98d; box-shadow: inset 4px 0 0 #d99a00; }
  .compare-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; margin-bottom: 12px; }
  .group-members { color: #344054; font-size: 13px; line-height: 1.55; margin-top: 6px; word-break: break-word; }
  .pair-evidence { margin: 8px 0 0; padding-left: 18px; color: #344054; font-size: 13px; line-height: 1.5; }
  .compare-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 12px; align-items: start; }
  .compare-student { border: 1px solid #eaecf0; border-radius: 8px; padding: 12px; background: #fcfcfd; }
  .compare-student-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
  .mini-score { min-width: 42px; height: 32px; border-radius: 6px; display: grid; place-items: center; background: var(--ink); color: #fff; font-size: 16px; font-weight: 800; }
  .compare-images { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 10px; }
  .compare-images a { position: relative; display: block; background: #f8fafc; border: 1px solid #d0d5dd; border-radius: 6px; overflow: auto; min-height: 260px; max-height: 560px; }
  .compare-images a.hit { border-color: #f04438; box-shadow: inset 0 0 0 2px #f04438; }
  .hit-label { position: sticky; top: 0; left: 0; z-index: 1; display: inline-flex; margin: 8px; padding: 3px 7px; border-radius: 6px; background: #f04438; color: #fff; font-size: 12px; font-weight: 800; }
  .compare-images img { width: 100%; height: auto; object-fit: contain; display: block; }
  @media (max-width: 760px) {
    header, main { padding-left: 14px; padding-right: 14px; }
    .cards { grid-template-columns: 1fr; }
    .compare-grid { grid-template-columns: 1fr; }
    .card-head { align-items: stretch; }
    table { min-width: 680px; }
  }
</style>
</head>
<body>
<header>
  <h1>${esc(reportTitle)}</h1>
  <div class="summary">
    <span class="chip">生成时间：${esc(generatedAt)}</span>
    <span class="chip">提交总数：${summary.submissionCount}</span>
    <span class="chip">待批草稿：${summary.active.length}</span>
    <span class="chip">已批跳过：${summary.skipped}</span>
    <span class="chip strong">确认雷同人数：${summary.confirmedPeople}</span>
    <span class="chip">疑似人数：${summary.suspectedPeople}</span>
    <span class="chip">分数分布：${esc(summary.scoreText || '无')}</span>
    <span class="chip"><a href="grading_draft_advanced.csv">grading_draft_advanced.csv</a></span>
    <span class="chip"><a href="advanced_similarity.csv">advanced_similarity.csv</a></span>
  </div>
</header>
<main>
  <div class="layout">
    <section>
      <h2>班级概览</h2>
      <div class="panel">${renderClassTable(summary.classRows)}</div>
    </section>

    <section>
      <h2>雷同后交 0 分</h2>
      <div class="panel">${renderZeroTable(summary.plagiarismZeros)}</div>
    </section>

    <section>
      <h2>内容无法证明完成的 0 分</h2>
      <div class="panel">${renderZeroTable(summary.contentZeros)}</div>
    </section>

    <section>
      <h2>高级相似检测明细</h2>
      <div class="panel">${renderPairTable(pairs)}</div>
    </section>

    <section>
      <h2>确认雷同截图对比</h2>
      <div class="compare-list">${renderSimilarityComparison(pairs, byId, draftById, 'confirmed')}</div>
    </section>

    <section>
      <h2>疑似雷同截图对比</h2>
      <div class="compare-list">${renderSimilarityComparison(pairs, byId, draftById, 'suspected')}</div>
    </section>

    <section>
      <h2>待批学生草稿</h2>
      <div class="cards">${renderCards(pendingDrafts, byId)}</div>
    </section>

    <section>
      <h2>已批作业/判例截图</h2>
      <div class="cards">${renderCards(skippedDrafts, byId)}</div>
    </section>
  </div>
</main>
</body>
</html>`;
}

async function main() {
  const [drafts, submissions, pairs, metadata] = await Promise.all([
    readJson(path.join(runDir, 'grading_draft.json')),
    loadSubmissions(runDir),
    readJson(path.join(runDir, 'advanced_similarity.json'), []),
    readJson(path.join(runDir, 'metadata.json'), {}),
  ]);
  const localOverrides = await applyLocalVisionOverrides(runDir, submissions);
  const html = renderHtml({ drafts, submissions, pairs, metadata });
  await mkdir(runDir, { recursive: true });
  const advancedFile = path.join(runDir, 'review_report_advanced.html');
  await writeFile(advancedFile, html, 'utf8');
  console.log(`Wrote: ${advancedFile}`);
  if (replaceMain) {
    const mainFile = path.join(runDir, 'review_report.html');
    await writeFile(mainFile, html, 'utf8');
    console.log(`Wrote: ${mainFile}`);
  }
  if (localOverrides) console.log(`Applied local vision overrides: ${localOverrides}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
