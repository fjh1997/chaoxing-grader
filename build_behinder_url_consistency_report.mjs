#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignments } from './assignment_manifest.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out || path.join(baseDir, 'behinder_url_review'));
const forceOcr = Boolean(args['force-ocr']);
const noOcr = Boolean(args['no-ocr']);
const noOrigin = Boolean(args['no-origin']);
const originTimeout = Math.max(3, Number(args['origin-timeout'] || process.env.CHAOXING_ORIGIN_TIMEOUT || 12));
const tesseractExe = args.tesseract || process.env.TESSERACT_EXE || '/mnt/c/Program Files/Tesseract-OCR/tesseract.exe';
const defaultKeys = ['zuoye7-upload', 'zuoye8-sql', 'zuoye9-memory-shell'];
const selectedKeys = String(args.keys || '').split(/[,;\s]+/).filter(Boolean);
const selected = assignments.filter(item => {
  const wanted = selectedKeys.length ? selectedKeys : defaultKeys;
  return wanted.includes(item.key) || wanted.includes(item.title) || wanted.includes(item.runDir);
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function slug(value, fallback = 'item') {
  const s = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 140);
  return s || fallback;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, cols) {
  return [
    cols.map(csvEscape).join(','),
    ...rows.map(row => cols.map(col => csvEscape(row[col])).join(',')),
  ].join('\n') + '\n';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/[\\｜]/g, '/')
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function toWindowsPath(file) {
  const resolved = path.resolve(file);
  const match = resolved.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!match) return resolved;
  return `${match[1].toUpperCase()}:\\${match[2].split('/').join('\\')}`;
}

function isLikelyStudentAnswerImage(asset) {
  const bytes = Number(asset?.bytes || 0);
  const file = String(asset?.file || '').toLowerCase();
  if (!asset?.ok || !asset?.file) return false;
  if (/(?:^|[/_-])(avatar|head|icon|logo|button|btn|emoji|face|loading|blank|default|popclose|rotate|revoke|eidt)(?:[/_.-]|$)/i.test(file)) return false;
  if (bytes > 0 && bytes < 5000) return false;
  return true;
}

function imageIdFromUrl(src) {
  const text = String(src || '');
  const match = text.match(/\/star3\/(?:origin|750_1024)\/([^/?#]+)$/i)
    || text.match(/\/star4\/([^/?#]+)\/origin(?:\.[a-z0-9]+)?$/i);
  return match?.[1]?.replace(/\.[a-z0-9]+$/i, '') || '';
}

function originUrlForAsset(asset) {
  const src = String(asset?.src || '');
  let url;
  try {
    url = new URL(src);
  } catch {
    return '';
  }
  const id = imageIdFromUrl(src);
  if (!id) return '';
  if (url.hostname === 'p.ananas.chaoxing.com') {
    if (/^\/star3\/origin\//i.test(url.pathname)) return src;
    if (/^\/star3\/750_1024\//i.test(url.pathname)) {
      return `https://p.ananas.chaoxing.com/star3/origin/${id}.jpg`;
    }
  }
  if (url.hostname === 'p.cldisk.com') {
    if (/^\/star3\/origin\//i.test(url.pathname) || /^\/star4\/[^/]+\/origin/i.test(url.pathname)) return src;
    if (/^\/star3\/750_1024\//i.test(url.pathname)) {
      return `https://p.cldisk.com/star3/origin/${id}.jpg`;
    }
  }
  return '';
}

async function localBytes(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function validImage(file) {
  try {
    execFileSync('identify', ['-quiet', '-regard-warnings', '-format', '%w %h', file], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

async function downloadOriginAsset(runDir, asset) {
  if (noOrigin) return asset;
  const originUrl = originUrlForAsset(asset);
  if (!originUrl) return asset;
  const imageId = imageIdFromUrl(originUrl) || imageIdFromUrl(asset.src) || asset.sha256 || asset.file;
  const ext = path.extname(new URL(originUrl).pathname) || '.jpg';
  const originDir = path.join(runDir, 'behinder_url_origin');
  const originFile = path.join(originDir, `${slug(imageId, 'origin')}_origin${ext}`);
  await mkdir(originDir, { recursive: true });

  if (!await exists(originFile)) {
    try {
      execFileSync('curl', [
        '-L',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time', String(originTimeout),
        '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        '-e', 'https://mooc2-ans.chaoxing.com',
        '-H', 'accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        '-o', originFile,
        originUrl,
      ], { timeout: (originTimeout + 5) * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return asset;
    }
  }

  const originBytes = await localBytes(originFile);
  if (!originBytes || !validImage(originFile)) {
    await rm(originFile, { force: true });
    return asset;
  }
  const localFile = asset.file ? path.join(runDir, asset.file) : '';
  const thumbBytes = Number(asset.bytes || await localBytes(localFile));
  if (originBytes <= Math.max(thumbBytes, 0)) return asset;
  return {
    ...asset,
    ocrFile: path.relative(runDir, originFile),
    ocrSrc: originUrl,
    ocrKey: `origin_${imageId}_${originBytes}`,
    ocrBytes: originBytes,
  };
}

function imageDimensions(file) {
  try {
    const out = execFileSync('identify', ['-format', '%w %h', file], {
      encoding: 'utf8',
      timeout: 15000,
    }).trim();
    const [width, height] = out.split(/\s+/).map(Number);
    return { width: width || 0, height: height || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

async function prepareOcrAssets(runDir, assets) {
  const out = [];
  for (const asset of assets) out.push(await downloadOriginAsset(runDir, asset));
  return out;
}

function selectAssets(submission) {
  const assets = Array.isArray(submission.assets) ? submission.assets : [];
  const rawAssets = Array.isArray(submission.rawAssets) ? submission.rawAssets : [];
  const preferred = assets.some(isLikelyStudentAnswerImage) ? assets : rawAssets;
  const out = [];
  const seen = new Set();
  for (const asset of preferred) {
    if (!isLikelyStudentAnswerImage(asset)) continue;
    const key = asset.file || asset.src;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

async function ocrAsset(runDir, asset) {
  const ocrDir = path.join(runDir, 'behinder_url_ocr');
  await mkdir(ocrDir, { recursive: true });
  const key = slug(asset.ocrKey || asset.ocrFile || asset.sha256 || asset.file);
  const outFile = path.join(ocrDir, `${key}.txt`);
  if (!forceOcr && await exists(outFile)) return readFile(outFile, 'utf8');

  const src = path.resolve(runDir, asset.ocrFile || asset.file);
  const tmpDir = '/mnt/c/Temp/cx_behinder_url_ocr';
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${key}.png`);
  const { width, height } = imageDimensions(src);
  const longSide = Math.max(width, height);
  const resize = longSide >= 1600 ? '1600x1600>' : '220%';
  try {
    execFileSync('convert', [
      src,
      '-auto-orient',
      '-resize', resize,
      '-colorspace', 'Gray',
      '-sharpen', '0x1',
      tmp,
    ], { timeout: 120000 });
  } catch {
    await copyFile(src, tmp);
  }
  const winPath = toWindowsPath(tmp);
  const outputs = [];
  for (const psm of ['6', '11']) {
    try {
      outputs.push(execFileSync(tesseractExe, [
        winPath,
        'stdout',
        '-l', 'eng',
        '--psm', psm,
      ], {
        encoding: 'utf8',
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (error) {
      outputs.push(String(error?.stderr || error?.message || error));
    }
  }
  const text = outputs.join('\n\n');
  await writeFile(outFile, text, 'utf8');
  return text;
}

function assignmentRule(item) {
  const text = `${item.key}\n${item.title}\n${item.runDir}`.toLowerCase();
  if (/memory|内存马|作业九/.test(text)) {
    return {
      type: 'memory-shell',
      label: '内存马与代码注入',
      allowedApps: new Set(['memory-shell']),
      expected: '本作业的冰蝎 URL/路径应指向 examonline 内存马路径，例如 /examonline/shell_*.txt、/examonline/<filter path>。',
    };
  }
  if (/sql|sqli|作业八/.test(text)) {
    return {
      type: 'sql-injection',
      label: 'SQL 注入写入 WebShell',
      allowedApps: new Set(['sql-injection', 'root-webshell']),
      expected: '本作业的冰蝎 URL/路径应指向 SQL 注入写入的 WebShell；payload 写入目录可自定义，因此 /sqli/*.jsp 或站点根目录下的 hack/shell/*.jsp 都可接受。',
    };
  }
  if (/upload|文件上传|作业七/.test(text)) {
    return {
      type: 'file-upload',
      label: '文件上传 WebShell',
      allowedApps: new Set(['file-upload']),
      expected: '本作业的冰蝎 URL/路径应指向文件上传靶场的上传目录，例如 /campusbbs/uploads/*.jsp 或 /upload/*.jsp。',
    };
  }
  return {
    type: 'unknown',
    label: '未配置',
    allowedApps: new Set(),
    expected: '未配置冰蝎 URL/路径规则。',
  };
}

function classifyPath(value) {
  const v = normalizeText(value).replace(/\s+/g, '');
  const compact = v.replace(/[^a-z0-9/._:-]/g, '');
  const pathish = compact
    .replace(/\/{2,}/g, '/')
    .replace(/(?:exmonine|examonine|exammine\/?online|exammine|examoniine|examoniine|exam0nline|examineonline)/g, 'examonline')
    .replace(/\/?examonline(?=[a-z0-9_-])/g, '/examonline/')
    .replace(/(?:snel|shel1|sheil|hell)(?=[_.-]?\d|\b)/g, 'shell')
    .replace(/campusbb[s5]/g, 'campusbbs')
    .replace(/(?:upl0ads|upioads|uplosds|uploods|up1oads|upioad|uploadsi|uploads[a-z0-9_-]*)/g, 'uploads')
    .replace(/(?:sqii|sql1|sqlif|sqliwwk|sqlihack|sqlihacks)/g, 'sqli')
    .replace(/\/sqli(?=hack|hacks|shell|[\d_])/g, '/sqli/')
    .replace(/\/campusbbs\/uploads(?=[a-z0-9_-])/g, '/campusbbs/uploads/');
  const rootPath = pathish.replace(/^(?:https?:)?\/?(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|[a-z0-9.-]+)(?::\d{2,5})?/i, '');
  if (/\/examonline\//i.test(pathish) || /\/examin?e?online\//i.test(pathish)) return 'memory-shell';
  if (/\/sqli\//i.test(pathish)) return 'sql-injection';
  if (/\/campusbbs\/uploads(?:\/|[a-z0-9_.-])/i.test(pathish) || /\/upload(?:s)?\//i.test(pathish)) return 'file-upload';
  if (/\/session\//i.test(v)) return 'cookie-session';
  if (/\/phoneshop\//i.test(v)) return 'logic-phoneshop';
  if (/\/campusbbs\//i.test(pathish)) return 'campusbbs-other';
  if (/^\/(?:hack|hacks|shell|sh3ll|sshell|memshell|behinderfilter)[\w.-]*(?:[,.]?(?:jsp|jspx|txt|do|action|tet|ixt))?$/i.test(rootPath)) return 'root-webshell';
  return '';
}

function isMeaningfulPath(value) {
  const v = normalizeText(value).replace(/\s+/g, '');
  if (!v) return false;
  if (/^https?:?\/?$/.test(v)) return false;
  if (/^https?:\/\/(?:www|java_oracle)$/i.test(v)) return false;
  if (/^(?:http:)?(?:weww|www)$/i.test(v)) return false;
  return true;
}

function normalizeCandidatePath(value) {
  return normalizeText(value)
    .replace(/(\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d{1,3})\s*[;:]\s*(\d{2,5})\s*[v\\/|]?\s*/g, '$1.$2:$3/')
    .replace(/((?:\d{1,3}\.){3}\d{1,3})\s*[;]\s*(\d{2,5})/g, '$1:$2')
    .replace(/\s+/g, '')
    .replace(/^[^0-9a-z/]*(?=(?:\d{1,3}\.){2}\d{1,3})/i, '')
    .replace(/^(?:nitpir|nttp|nhttp|hittp|httpi)(?=\d)/i, 'http://')
    .replace(/([:]\d{2,5})[v|](?=(?:ex|sqli|campus|upload|session|phone))/i, '$1/')
    .replace(/(?:exmonine|examonine|exammine\/?online|exammine|examoniine|exam0nline|examineonline)/gi, 'examonline')
    .replace(/\/?examonline(?=[a-z0-9_-])/gi, '/examonline/')
    .replace(/(?:snel|shel1|sheil|hell)(?=[_.-]?\d|\b)/gi, 'shell')
    .replace(/[),.;，。；]+$/g, '');
}

function extractPaths(rawText) {
  const text = normalizeText(rawText)
    .replace(/h\s*t\s*t\s*p\s*s?\s*:/g, 'http:')
    .replace(/htps:/g, 'https:')
    .replace(/httos:/g, 'https:')
    .replace(/hittp:/g, 'http:')
    .replace(/(\d{1,3}\.\d{1,3}\.\d{1,3})\s+(\d{1,3})\s*[;:]\s*(\d{2,5})\s*[v\\/|]?\s*/g, '$1.$2:$3/')
    .replace(/((?:\d{1,3}\.){3}\d{1,3})\s*[;]\s*(\d{2,5})/g, '$1:$2');
  const pieces = [];
  const patterns = [
    /https?:\s*\/{0,2}[^\s'"<>，。；]+/gi,
    /(?:(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}|localhost:\d{2,5})[^\s'"<>，。；]*/gi,
    /(?:(?:\d{1,3}[.\s]){3}\d{1,3}\s*[;:]\s*\d{2,5})[^\s'"<>，。；]*/gi,
    /\/(?:examonline|sqli|upload|uploads|session|phoneshop|campusbbs)\/[^\s'"<>，。；]*/gi,
    /\/(?:hack|hacks|shell|sh3ll|sshell|memshell|behinderfilter)[\w.-]*(?:[,.]?(?:jsp|jspx|txt|do|action|tet|ixt))?\b/gi,
    /\b(?:shell|shel1|sh3ll|hack|hacks|memshell|behinderfilter)[\w.-]*(?:\.(?:jsp|jspx|txt|do|action|tet|ixt))?\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      let value = normalizeCandidatePath(match[0]);
      if (!value) continue;
      if (/apache|tomcat-|java\.oracle|closer\.cgi|tar\.gz|register\.html|login\.html|web-inf|meta-inf|\/css\b/.test(value)) continue;
      if (!isMeaningfulPath(value)) continue;
      pieces.push(value);
    }
  }
  return [...new Set(pieces)].slice(0, 20);
}

function hasBehinderEvidence(text) {
  return /冰蝎|behinder|rebeyond|web远程管理|webshell|已连接|连接成功|basic info|environment variable|java_home|catalina_home|java\.runtime\.name|java\.vm|jre系统属性|环境变量/i.test(text);
}

function hasGenericShellOnly(paths) {
  if (!paths.length) return false;
  return paths.every(value => /^(?:shell|shel1|sh3ll|shell\.jsp|hack|hacks|hack1234|memshell)$/i.test(value));
}

function ownerMismatch(paths, submission, knownStudents) {
  const mismatches = [];
  for (const value of paths) {
    for (const match of String(value).matchAll(/\b\d{10}\b/g)) {
      const studentNo = match[0];
      if (studentNo === String(submission.studentNo || '')) continue;
      const owner = knownStudents.get(studentNo);
      if (!owner) continue;
      mismatches.push({
        path: value,
        studentNo,
        owner: `${owner.name}(${owner.studentNo}) ${owner.className}`,
      });
    }
  }
  return mismatches;
}

function scoreNumber(row) {
  const n = Number(row?.earlyBonusBaseScore ?? row?.draftScore ?? row?.score ?? row?.existingScore);
  return Number.isFinite(n) ? n : 0;
}

function finalScoreNumber(row) {
  const n = Number(row?.draftScore ?? row?.score ?? row?.existingScore);
  return Number.isFinite(n) ? n : 0;
}

function verdictFor({ rule, paths, submission, knownStudents, behinder }) {
  const classified = paths.map(value => ({ value, app: classifyPath(value) }));
  const allowed = classified.filter(row => row.app && rule.allowedApps.has(row.app));
  const wrong = classified.filter(row => row.app && !rule.allowedApps.has(row.app));
  const owner = allowed.length ? [] : ownerMismatch(paths, submission, knownStudents);
  const genericOnly = hasGenericShellOnly(paths);
  if (owner.length) {
    return {
      status: 'path-owner-mismatch',
      severity: 'high',
      allowed,
      wrong,
      owner,
      reason: `路径中出现其他学生学号：${owner.map(x => `${x.studentNo} ${x.owner}`).join('；')}。`,
    };
  }
  if (wrong.length && !allowed.length) {
    return {
      status: 'wrong-assignment-path',
      severity: 'high',
      allowed,
      wrong,
      owner,
      reason: `检测到其他实验路径：${wrong.map(x => `${x.value}(${x.app})`).join('；')}。`,
    };
  }
  if (behinder && !allowed.length) {
    return {
      status: genericOnly ? 'generic-shell-path-only' : 'missing-current-assignment-url',
      severity: 'medium',
      allowed,
      wrong,
      owner,
      reason: genericOnly
        ? '只有通用 shell/hack 标识，无法证明 URL/路径属于本次作业。'
        : '有冰蝎/连接/环境信息，但没有识别到符合本次作业的 URL/路径。',
    };
  }
  return {
    status: allowed.length ? 'ok' : 'not-behinder-or-no-url',
    severity: allowed.length ? 'ok' : 'low',
    allowed,
    wrong,
    owner,
    reason: allowed.length ? 'URL/路径与当前作业类型一致。' : '未检测到冰蝎 URL/路径证据。',
  };
}

function suggestedScore(row, verdict) {
  const current = scoreNumber(row);
  if (current === 0) return 0;
  if (verdict.status === 'path-owner-mismatch') return Math.min(current, 30);
  if (verdict.status === 'wrong-assignment-path') return Math.min(current, 35);
  if (verdict.status === 'generic-shell-path-only' || verdict.status === 'missing-current-assignment-url') return Math.min(current, 45);
  return current;
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function relAssetPath(reportFile, runDir, asset) {
  const file = asset?.ocrFile || asset?.file;
  if (!file) return '';
  return path.relative(path.dirname(reportFile), path.resolve(runDir, file)).split(path.sep).join('/');
}

function reportHtml({ rows, summaryRows, generatedAt, reportFile }) {
  const cards = rows.map(row => {
    const images = row.images.map(src => `<a href="${htmlEscape(src)}"><img src="${htmlEscape(src)}" loading="lazy"></a>`).join('');
    return `<section class="card sev-${htmlEscape(row.severity)}">
      <div class="head">
        <div>
          <h2>${htmlEscape(row.assignmentTitle)} · ${htmlEscape(row.className)} ${htmlEscape(row.name)} ${htmlEscape(row.studentNo)}</h2>
          <p>${htmlEscape(row.statusLabel)} · 当前基准 ${htmlEscape(row.currentBaseScore)} / 最终 ${htmlEscape(row.currentFinalScore)} · 建议基准 ${htmlEscape(row.suggestedBaseScore)}</p>
        </div>
        <span class="tag">${htmlEscape(row.status)}</span>
      </div>
      <div class="reason">${htmlEscape(row.reason)}</div>
      <table>
        <tr><th>本作业要求</th><td>${htmlEscape(row.expected)}</td></tr>
        <tr><th>识别 URL/路径</th><td>${htmlEscape(row.paths || '无')}</td></tr>
        <tr><th>匹配当前作业</th><td>${htmlEscape(row.allowedPaths || '无')}</td></tr>
        <tr><th>不匹配路径</th><td>${htmlEscape(row.wrongPaths || '无')}</td></tr>
        <tr><th>其他学生路径</th><td>${htmlEscape(row.ownerMismatches || '无')}</td></tr>
        <tr><th>证据摘要</th><td>${htmlEscape(row.evidenceSnippet)}</td></tr>
      </table>
      <div class="images">${images}</div>
    </section>`;
  }).join('\n');
  const summary = summaryRows.map(row => `<tr><td>${htmlEscape(row.assignmentTitle)}</td><td>${htmlEscape(row.total)}</td><td>${htmlEscape(row.flagged)}</td><td>${htmlEscape(row.needsLowerScore)}</td><td>${htmlEscape(row.statusCounts)}</td></tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>冰蝎 URL/路径一致性复核报告</title>
<style>
body{margin:0;background:#f6f7f9;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:24px 28px;background:#101827;color:#fff}
h1{margin:0 0 8px;font-size:24px}
.meta{color:#cbd5e1}
main{padding:22px;max-width:1400px;margin:auto}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top;font-size:13px}
.card{background:#fff;border:1px solid #e5e7eb;border-left:5px solid #94a3b8;border-radius:8px;margin:18px 0;padding:16px}
.sev-high{border-left-color:#dc2626}.sev-medium{border-left-color:#d97706}.sev-ok{border-left-color:#16a34a}
.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
h2{margin:0;font-size:17px}.head p{margin:6px 0 0;color:#64748b}
.tag{background:#eef2ff;color:#3730a3;padding:4px 8px;border-radius:999px;font-size:12px;white-space:nowrap}
.reason{margin:12px 0;padding:10px;background:#fff7ed;border-radius:6px;color:#7c2d12}
.images{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:12px}
img{width:100%;max-height:260px;object-fit:contain;background:#0f172a;border-radius:6px}
.summary{margin:0 0 20px}
</style>
</head>
<body>
<header>
  <h1>冰蝎 URL/路径一致性复核报告</h1>
  <div class="meta">生成时间：${htmlEscape(generatedAt)} · 报告文件：${htmlEscape(reportFile)}</div>
</header>
<main>
  <table class="summary">
    <thead><tr><th>作业</th><th>提交数</th><th>报告条目</th><th>建议降分</th><th>状态分布</th></tr></thead>
    <tbody>${summary}</tbody>
  </table>
  ${cards || '<p>未发现需要报告的冰蝎 URL/路径问题。</p>'}
</main>
</body>
</html>`;
}

async function loadSubmissions(runDir) {
  const dir = path.join(runDir, 'submissions');
  if (!await exists(dir)) return [];
  const rows = [];
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.json')).sort()) {
    const row = await readJson(path.join(dir, file), null);
    if (row?.workAnswerId) rows.push(row);
  }
  return rows;
}

async function loadDrafts(runDir) {
  const rows = await readJson(path.join(runDir, 'grading_draft_submit_early_bonus.json'), null)
    || await readJson(path.join(runDir, 'grading_draft.json'), []);
  return new Map((Array.isArray(rows) ? rows : []).map(row => [String(row.workAnswerId), row]));
}

async function buildKnownStudents() {
  const known = new Map();
  for (const item of assignments) {
    for (const sub of await loadSubmissions(path.resolve(item.runDir))) {
      if (sub.studentNo) known.set(String(sub.studentNo), {
        studentNo: String(sub.studentNo),
        name: sub.name || '',
        className: sub.className || '',
      });
    }
  }
  return known;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const knownStudents = await buildKnownStudents();
  const generatedAt = new Date().toISOString();
  const reportFile = path.join(outDir, 'behinder_url_consistency_report.html');
  const rows = [];
  const allRows = [];
  const summaryRows = [];

  for (const item of selected) {
    const runDir = path.resolve(item.runDir);
    const rule = assignmentRule(item);
    const submissions = await loadSubmissions(runDir);
    const drafts = await loadDrafts(runDir);
    const statusCounts = new Map();
    let flagged = 0;
    let needsLowerScore = 0;
    console.log(`Scanning ${item.title} (${submissions.length})`);

    for (const [index, sub] of submissions.entries()) {
      const assets = await prepareOcrAssets(runDir, selectAssets(sub));
      const visionText = [
        sub.vision?.extractedText,
        sub.vision?.summary,
        sub.vision?.comment,
        sub.vision?.shellUrlOrPath,
        sub.vision?.strongShellUrlOrPath,
        sub.vision?.weakShellUrlOrPath,
      ].filter(Boolean).join('\n');
      const ocrTexts = [];
      if (!noOcr) {
        for (const asset of assets) {
          ocrTexts.push(await ocrAsset(runDir, asset));
        }
      }
      const evidenceText = [visionText, ...ocrTexts].join('\n');
      const paths = extractPaths(evidenceText);
      const behinder = hasBehinderEvidence(evidenceText) || paths.some(value => /shell|hack|memshell|behinder/i.test(value));
      const verdict = verdictFor({ rule, paths, submission: sub, knownStudents, behinder });
      const draft = drafts.get(String(sub.workAnswerId)) || {};
      const currentBaseScore = scoreNumber(draft);
      const currentFinalScore = finalScoreNumber(draft);
      const suggestedBaseScore = suggestedScore(draft, verdict);
      const shouldReport = behinder && verdict.status !== 'ok' && verdict.status !== 'not-behinder-or-no-url';
      statusCounts.set(verdict.status, (statusCounts.get(verdict.status) || 0) + 1);
      if (shouldReport) flagged++;
      if (suggestedBaseScore < currentBaseScore) needsLowerScore++;

      const row = {
        assignmentKey: item.key,
        assignmentTitle: item.title,
        runDir: item.runDir,
        className: sub.className || '',
        name: sub.name || '',
        studentNo: sub.studentNo || '',
        workAnswerId: String(sub.workAnswerId || ''),
        submitTime: sub.submitTime || '',
        status: verdict.status,
        statusLabel: verdict.status === 'path-owner-mismatch'
          ? '路径疑似属于其他学生'
          : verdict.status === 'wrong-assignment-path'
          ? '路径属于其他实验'
          : verdict.status === 'generic-shell-path-only'
          ? '只有通用 shell/hack 路径'
          : verdict.status === 'missing-current-assignment-url'
          ? '缺少本作业 URL/路径'
          : verdict.status,
        severity: verdict.severity,
        expected: rule.expected,
        paths: paths.join('; '),
        allowedPaths: verdict.allowed.map(x => x.value).join('; '),
        wrongPaths: verdict.wrong.map(x => `${x.value} (${x.app})`).join('; '),
        ownerMismatches: verdict.owner.map(x => `${x.path} -> ${x.owner}`).join('; '),
        reason: verdict.reason,
        currentBaseScore,
        currentFinalScore,
        suggestedBaseScore,
        needsLowerScore: suggestedBaseScore < currentBaseScore,
        evidenceSnippet: normalizeText(evidenceText).slice(0, 900),
        imageFiles: assets.map(asset => asset.ocrFile ? `${asset.file} -> ${asset.ocrFile}` : asset.file).join('; '),
        images: assets.slice(0, 6).map(asset => relAssetPath(reportFile, runDir, asset)).filter(Boolean),
      };
      allRows.push(row);
      if (shouldReport) rows.push(row);
      if ((index + 1) % 25 === 0) console.log(`  ${index + 1}/${submissions.length}`);
    }

    summaryRows.push({
      assignmentKey: item.key,
      assignmentTitle: item.title,
      total: submissions.length,
      flagged,
      needsLowerScore,
      statusCounts: [...statusCounts.entries()].map(([k, v]) => `${k}:${v}`).join(', '),
    });
  }

  rows.sort((a, b) =>
    a.assignmentTitle.localeCompare(b.assignmentTitle, 'zh-Hans-CN')
    || severityRank(a.severity) - severityRank(b.severity)
    || a.className.localeCompare(b.className, 'zh-Hans-CN')
    || String(a.studentNo).localeCompare(String(b.studentNo), 'zh-Hans-CN'));

  await writeFile(path.join(outDir, 'behinder_url_consistency_report.json'), JSON.stringify(rows, null, 2), 'utf8');
  await writeFile(path.join(outDir, 'behinder_url_consistency_all.json'), JSON.stringify(allRows, null, 2), 'utf8');
  await writeFile(path.join(outDir, 'behinder_url_consistency_report.csv'), toCsv(rows, [
    'assignmentTitle', 'className', 'name', 'studentNo', 'workAnswerId', 'submitTime',
    'status', 'reason', 'paths', 'allowedPaths', 'wrongPaths', 'ownerMismatches',
    'currentBaseScore', 'currentFinalScore', 'suggestedBaseScore', 'needsLowerScore',
    'expected', 'evidenceSnippet', 'imageFiles',
  ]), 'utf8');
  await writeFile(path.join(outDir, 'behinder_url_consistency_summary.csv'), toCsv(summaryRows, [
    'assignmentKey', 'assignmentTitle', 'total', 'flagged', 'needsLowerScore', 'statusCounts',
  ]), 'utf8');
  await writeFile(reportFile, reportHtml({ rows, summaryRows, generatedAt, reportFile }), 'utf8');
  console.log(`Wrote ${reportFile}`);
  console.log(`Flagged rows: ${rows.length}`);
  console.log(`Rows needing lower score: ${rows.filter(row => row.needsLowerScore).length}`);
}

function severityRank(value) {
  if (value === 'high') return 0;
  if (value === 'medium') return 1;
  if (value === 'ok') return 2;
  return 3;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
