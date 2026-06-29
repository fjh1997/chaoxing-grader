#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const runDir = path.resolve(process.argv[2] || 'runs/example');
const useLog4jScorePolicy = process.argv.includes('--log4j-score-policy')
  || process.env.USE_LOG4J_SCORE_POLICY === '1'
  || /log4j/i.test(runDir);

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [
    columns.map(csvEscape).join(','),
    ...rows.map(row => columns.map(col => csvEscape(row[col])).join(',')),
  ].join('\n') + '\n';
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readJsonOptional(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        value += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(value);
      value = '';
    } else if (ch === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (ch !== '\r') {
      value += ch;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return body
    .filter(values => values.some(cell => cell !== ''))
    .map(values => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ''])));
}

async function loadSubmissions(dir) {
  const submissionsDir = path.join(dir, 'submissions');
  const names = (await readdir(submissionsDir)).filter(name => name.endsWith('.json')).sort();
  const rows = [];
  for (const name of names) rows.push(await readJson(path.join(submissionsDir, name)));
  return rows;
}

async function applyLocalVisionOverrides(dir, submissions) {
  const rows = await readJsonOptional(path.join(dir, 'local_vision_overrides.json'), []);
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

function parseSubmitTime(value) {
  const text = String(value || '').trim();
  const full = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (full) {
    return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), Number(full[6] || 0)).getTime();
  }
  const partial = text.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (partial) {
    return new Date(new Date().getFullYear(), Number(partial[1]) - 1, Number(partial[2]), Number(partial[3]), Number(partial[4]), Number(partial[5] || 0)).getTime();
  }
  return Number.MAX_SAFE_INTEGER;
}

function hasHardEvidence(pair) {
  return Boolean(pair.exactObject || pair.exactFile || String(pair.exactShared || '').trim());
}

function confirmedBasisPairs(pairs) {
  return pairs.filter(pair => pair.verdict === 'confirmed' && hasHardEvidence(pair));
}

function confirmedDirectPairs(pairs) {
  return pairs.filter(pair => pair.verdict === 'confirmed' && !hasHardEvidence(pair));
}

function hardEvidenceGroupKeys(pair) {
  const exact = String(pair.exactShared || '')
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean)
    .sort();
  if (exact.length) return exact.map(item => `exact:${item}`);
  return [`hard-pair:${[String(pair.aWorkAnswerId), String(pair.bWorkAnswerId)].sort().join('|')}`];
}

function buildGroups(pairs) {
  const groups = new Map();
  for (const pair of confirmedBasisPairs(pairs)) {
    for (const key of hardEvidenceGroupKeys(pair)) {
      if (!groups.has(key)) groups.set(key, { key, ids: new Set(), pairs: [] });
      groups.get(key).ids.add(String(pair.aWorkAnswerId));
      groups.get(key).ids.add(String(pair.bWorkAnswerId));
      groups.get(key).pairs.push(pair);
    }
  }
  return [...groups.values()].filter(group => group.ids.size >= 2);
}

function confirmedPairsFor(id, pairs) {
  const key = String(id);
  return pairs.filter(pair =>
    pair.verdict === 'confirmed'
    && [String(pair.aWorkAnswerId), String(pair.bWorkAnswerId)].includes(key)
  );
}

function pairOtherId(pair, id) {
  return String(pair.aWorkAnswerId) === String(id) ? String(pair.bWorkAnswerId) : String(pair.aWorkAnswerId);
}

function pairStrength(pair) {
  return Number(pair.evidenceSimilarity || 0) * 100000
    + Number(pair.siftInliers || 0)
    + Number(pair.akazeInliers || 0);
}

function directSourceFor(row, pairs, byId, subById) {
  const candidates = confirmedPairsFor(row.workAnswerId, pairs)
    .map(pair => {
      const otherId = pairOtherId(pair, row.workAnswerId);
      const other = byId.get(String(otherId));
      const otherSub = subById.get(String(otherId));
      return {
        pair,
        other,
        submitTime: parseSubmitTime(otherSub?.submitTime || ''),
      };
    })
    .filter(item => item.other)
    .filter(item => item.submitTime <= parseSubmitTime(subById.get(String(row.workAnswerId))?.submitTime || ''));
  return candidates.sort((a, b) =>
    a.submitTime - b.submitTime
    || pairStrength(b.pair) - pairStrength(a.pair)
    || String(a.other.studentNo || '').localeCompare(String(b.other.studentNo || ''), 'zh-Hans-CN')
  )[0];
}

function baselineFromSubmission(row, sub) {
  if (row.skip) return row;
  const resetText = [row.risk, row.basis, row.draftComment].join('\n');
  const vision = sub?.vision;
  const hasVisionScore = vision && Number.isFinite(Number(vision.score));
  const shouldApplyVision = hasVisionScore && (
    /local-evidence|local_review|本地截图复核|mimo-openclaw-rubric/i.test(`${vision.model || ''}\n${vision.risk || ''}`)
    || /has three or more submitted images|has partial but usable evidence|has limited evidence|no usable answer content extracted/.test(resetText)
    || /advanced-confirmed|高级相似检测 confirmed|人工覆盖评分|自动证据分档/.test(resetText)
  );
  if (shouldApplyVision) {
    return rowFromVision(row, vision);
  }
  if (!/advanced-confirmed|高级相似检测 confirmed|人工覆盖评分|自动证据分档/.test(resetText)) {
    return row;
  }
  return {
    ...row,
    risk: '',
    basis: row.basis || 'advanced reset baseline',
  };
}

async function loadDraftBaseline(dir, currentDrafts) {
  const csvPath = path.join(dir, 'grading_draft.csv');
  try {
    const rows = parseCsv(await readFile(csvPath, 'utf8'));
    if (rows.length) {
      const currentById = new Map(currentDrafts.map(row => [String(row.workAnswerId), row]));
      return rows.map(row => ({
        ...currentById.get(String(row.workAnswerId)),
        ...row,
        approved: String(row.approved).toLowerCase() === 'true',
        skip: String(row.skip).toLowerCase() === 'true',
        draftScore: Number(row.draftScore),
      }));
    }
  } catch {}
  return currentDrafts;
}

function rowFromVision(row, vision) {
  const basis = `${visionBasisLabel(vision)}: content ${vision.contentScore ?? ''}/40, evidence ${vision.evidenceScore ?? ''}/40, layout ${vision.layoutScore ?? ''}/20`;
  let comment = vision.comment || row.draftComment || '';
  if (Array.isArray(vision.missing) && vision.missing.length && !comment.includes('缺失')) {
    comment += ` 缺失或不足：${vision.missing.join('、')}。`;
  }
  if (!comment.includes('评分依据')) comment += ` 评分依据：${basis}。`;
  return {
    ...row,
    draftScore: Number(vision.score),
    draftComment: comment,
    risk: '',
    basis,
  };
}

function visionBasisLabel(vision) {
  const model = String(vision?.model || '');
  const risk = String(vision?.risk || '');
  if (/local-evidence|local_review|本地截图复核/i.test(`${model}\n${risk}`)) return '本地截图复核';
  if (/mimo-openclaw-rubric/i.test(model)) return 'Mimo vision + 实验指导书';
  return 'Mimo vision';
}

function applyAdvancedZero(row, source, pair) {
  const otherName = source.other.name;
  row.draftScore = 0;
  row.risk = `${otherName}:advanced-confirmed`;
  row.basis = `高级相似检测 confirmed：直接相似的较早提交为 ${source.other.name}(${source.other.studentNo})；SIFT ${pair?.siftInliers ?? ''}/${pair?.siftRatio ?? ''}，AKAZE ${pair?.akazeInliers ?? ''}/${pair?.akazeRatio ?? ''}，核心证据 ${pair?.evidenceSimilarity ?? ''}`;
  row.draftComment = `作业与 ${source.other.name}(${source.other.studentNo}) 的局部截图和核心实验证据高度一致，且提交时间晚于对方，按“第一个做出来的有分，后续雷同作业 0 分”处理。`;
}

function printableRatio(text) {
  if (!text) return 0;
  let printable = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126)) printable++;
  }
  return printable / text.length;
}

function decodedBase64Text(text) {
  const chunks = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const value = match[0];
    if (seen.has(value)) continue;
    seen.add(value);
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (decoded.length >= 8 && printableRatio(decoded) > 0.75) chunks.push(decoded);
    } catch {}
  }
  return chunks.join('\n');
}

function rawEvidenceText(sub) {
  const vision = sub?.vision || {};
  const review = sub?.review || {};
  return [
    vision.extractedText || '',
    vision.summary || '',
    vision.comment || '',
    vision.rawText || '',
    review.answerText || '',
  ].join('\n');
}

function observedEvidenceText(sub) {
  const vision = sub?.vision || {};
  const review = sub?.review || {};
  return [
    vision.extractedText || '',
    review.answerText || '',
  ].join('\n');
}

function classifyEvidence(sub) {
  const raw = rawEvidenceText(sub);
  const observed = observedEvidenceText(sub);
  const decodedObserved = decodedBase64Text(observed);
  const text = `${raw}\n${decodedObserved}`;
  const observedPlusDecoded = `${observed}\n${decodedObserved}`;
  const hasDnslog = /jndi\s*:\s*dns|dnslog|log\.dnslog|dns\s*日志|dns回连/i.test(text);
  const hasClassLoad = /exectemplatejdk8|send\s+ldap\s+reference|jndi-injection-exploit|ldapserver|rmiserver|jettyserver/i.test(observedPlusDecoded);
  const hasTriggerPayload = /\$\{\s*jndi\s*:\s*(?:ldap|rmi|dns):|user-agent\s*:\s*\$\{\s*jndi|curl\s+-h/i.test(observedPlusDecoded);
  const hasFailure = /url\([^)]*\)\s*not\s+exist|\/tmp\/hacked[^。\n]*(?:不存在|missing|not\s+exist)|no\s+such\s+file|cannot\s+access|command\s+not\s+found/i.test(observedPlusDecoded);
  const hasShellOrFlag = /flag\{|cat\s+flag|cat\s+\/etc\/passwd|connection\s+received\s+on\s+\d{1,3}(?:\.\d{1,3}){3}|root@[a-z0-9_.-]+:\/#|uid=0\(\s*root\s*\)/i.test(observed);
  const hasObservedRcePath = /(?:get\s+)?\/(?:rce|rc5)[-_][^\s'"<>，。]*(?:root|whoami|hostname|b327|izbp|tomcat|www-data)[^\s'"<>，。]*(?:\s+http\/1\.1)?/i.test(observed);
  const hasTargetHttpCallback = /118\.31\.43\.132[\s\S]{0,180}(?:get\s+\/|code\s+404|message\s+file\s+not\s+found|http\/1\.1)|(?:get\s+\/|code\s+404|message\s+file\s+not\s+found|http\/1\.1)[\s\S]{0,180}118\.31\.43\.132/i.test(observed);
  const hasRceSuccess = hasShellOrFlag
    || hasObservedRcePath
    || (hasTargetHttpCallback && hasClassLoad && hasTriggerPayload);

  if (hasRceSuccess) {
    return {
      kind: 'rce_success',
      score: 100,
      label: '自动证据分档：检测到命令执行结果或 HTTP 外带 RCE 证据',
    };
  }
  if (hasFailure && (hasClassLoad || /\$\{\s*jndi\s*:/i.test(text))) {
    return {
      kind: 'failed_rce',
      score: 80,
      label: '自动证据分档：JNDI 可触发，但命令执行结果显示失败',
    };
  }
  if (hasDnslog && !hasClassLoad) {
    return {
      kind: 'dnslog_only',
      score: 90,
      label: '自动证据分档：DNSlog 回连成功，但未展示 RCE',
    };
  }
  if (hasClassLoad) {
    return {
      kind: 'class_load_only',
      score: 95,
      label: '自动证据分档：JNDI 类加载/回连成功，但未展示命令执行结果',
    };
  }
  return { kind: 'unknown', score: null, label: '' };
}

async function loadGradeOverrides(dir) {
  try {
    const rows = await readJson(path.join(dir, 'manual_grade_overrides.json'));
    const overrides = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row.workAnswerId) continue;
      overrides.set(String(row.workAnswerId), row);
    }
    return overrides;
  } catch {
    return new Map();
  }
}

function isAdvancedZero(row) {
  return Number(row.draftScore) === 0 && /advanced-confirmed|高级相似检测 confirmed/.test([row.risk, row.basis, row.draftComment].join('\n'));
}

function applyScorePolicy(row, overrides, sub) {
  const evidence = useLog4jScorePolicy ? classifyEvidence(sub) : { kind: 'unknown', score: null, label: '' };
  if (useLog4jScorePolicy && !row.skip && !isAdvancedZero(row) && evidence.score != null) {
    if (evidence.kind === 'rce_success' && Number(row.draftScore) >= 60) {
      return {
        ...row,
        draftScore: 100,
        basis: evidence.label,
      };
    }
    if (evidence.kind !== 'rce_success' && Number(row.draftScore) > evidence.score) {
      return {
        ...row,
        draftScore: evidence.score,
        basis: evidence.label,
        draftComment: row.draftComment,
      };
    }
    if (evidence.kind !== 'rce_success' && Number(row.draftScore) === evidence.score) {
      return {
        ...row,
        basis: evidence.label,
      };
    }
  }
  const override = overrides.get(String(row.workAnswerId));
  if (!row.skip && override && !isAdvancedZero(row)) {
    return {
      ...row,
      draftScore: Number(override.score),
      draftComment: override.comment || row.draftComment,
      basis: `人工覆盖评分：${override.score}分`,
    };
  }
  if (useLog4jScorePolicy && !row.skip && Number(row.draftScore) === 95) {
    return evidence.kind === 'rce_success'
      ? { ...row, draftScore: 100, basis: evidence.label || row.basis }
      : row;
  }
  return row;
}

async function main() {
  const currentDrafts = await readJson(path.join(runDir, 'grading_draft.json'));
  let drafts = await loadDraftBaseline(runDir, currentDrafts);
  const pairs = await readJson(path.join(runDir, 'advanced_similarity.json'));
  const submissions = await loadSubmissions(runDir);
  const localOverrides = await applyLocalVisionOverrides(runDir, submissions);
  const gradeOverrides = process.env.USE_MANUAL_GRADE_OVERRIDES === '1'
    ? await loadGradeOverrides(runDir)
    : new Map();
  const subById = new Map(submissions.map(row => [String(row.workAnswerId), row]));

  drafts = drafts.map(row => baselineFromSubmission(row, subById.get(String(row.workAnswerId))));
  const byId = new Map(drafts.map(row => [String(row.workAnswerId), row]));

  for (const group of buildGroups(pairs)) {
    const members = [...group.ids]
      .map(id => byId.get(String(id)))
      .filter(Boolean)
      .sort((a, b) => {
        const sa = subById.get(String(a.workAnswerId));
        const sb = subById.get(String(b.workAnswerId));
        return parseSubmitTime(sa?.submitTime || '') - parseSubmitTime(sb?.submitTime || '')
          || String(a.studentNo || '').localeCompare(String(b.studentNo || ''), 'zh-Hans-CN');
      });
    if (members.length < 2) continue;
    const first = members[0];
    for (const row of members.slice(1)) {
      if (row.skip) continue;
      const source = directSourceFor(row, group.pairs, byId, subById);
      if (!source) continue;
      const pair = source.pair;
      applyAdvancedZero(row, source, pair);
    }
  }

  for (const pair of confirmedDirectPairs(pairs)) {
    const a = byId.get(String(pair.aWorkAnswerId));
    const b = byId.get(String(pair.bWorkAnswerId));
    if (!a || !b) continue;
    const ordered = [a, b].sort((left, right) => {
      const leftSub = subById.get(String(left.workAnswerId));
      const rightSub = subById.get(String(right.workAnswerId));
      return parseSubmitTime(leftSub?.submitTime || '') - parseSubmitTime(rightSub?.submitTime || '')
        || String(left.studentNo || '').localeCompare(String(right.studentNo || ''), 'zh-Hans-CN');
    });
    const [first, later] = ordered;
    if (later.skip) continue;
    if (isAdvancedZero(later) && /同一上传对象|同一图片文件|本组最早提交/.test(String(later.basis || ''))) continue;
    applyAdvancedZero(later, { other: first, pair }, pair);
  }

  drafts = drafts.map(row => applyScorePolicy(row, gradeOverrides, subById.get(String(row.workAnswerId))));

  await writeFile(path.join(runDir, 'grading_draft.json'), JSON.stringify(drafts, null, 2), 'utf8');
  await writeFile(path.join(runDir, 'grading_draft_advanced.csv'), toCsv(drafts, [
    'approved', 'skip', 'className', 'name', 'studentNo', 'workAnswerId',
    'status', 'existingScore', 'draftScore', 'draftComment', 'risk', 'basis', 'reviewUrl',
  ]), 'utf8');
  if (localOverrides) console.log(`Applied local vision overrides: ${localOverrides}`);
  console.log(`Wrote: ${path.join(runDir, 'grading_draft_advanced.csv')}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
