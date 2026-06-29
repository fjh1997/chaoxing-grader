# 超星作业批改脚本

超星作业批改脚本，用于在已登录浏览器会话下批量采集学习通/超星作业、下载学生答案图片、调用视觉模型评分、用 OpenCV 做局部相似度检测、生成批改报告和排名，并可在人工确认后批量写回分数和评语。

本仓库只保留脚本、配置模板和提示词模板。不要提交学生名单、学号、作业截图、评分结果、真实课程 URL、浏览器 cookie 或 API key。

## 功能

- 通过 Chrome DevTools Protocol 使用本机已登录浏览器采集超星作业。
- 下载并过滤学生答案图片，剔除头像、按钮、题目插图等公共图片。
- 调用 Mimo 或其他 OpenAI-compatible 视觉模型，结合实验指导书与已批样例评分。
- 使用 OpenCV SIFT/AKAZE 进行局部相似度检测，并支持大模型二次复核。
- 生成单作业报告、全作业报告索引、班级/总分排名、早交加分版本。
- 支持先生成草稿，确认后再批量写回超星分数和评语。

## 环境

- Node.js 22+
- Python 3.10+
- `curl`
- ImageMagick `convert`
- OpenCV Python 依赖

安装 Python 依赖：

```bash
python -m venv .venv-cv
.venv-cv/bin/pip install -r requirements-cv.txt
```

复制环境变量模板：

```bash
cp .env.example .env
```

在 `.env` 中填写视觉模型配置，或者直接在 shell 中导出：

```bash
export MIMO_ENDPOINT='https://api.openai.com/v1'
export MIMO_MODEL='mimo-v2.5'
export MIMO_API_KEY='your-api-key'
export CDP_PROXY_URL='http://localhost:3456'
```

## 配置作业

编辑 `assignment_manifest.mjs`，把 `url` 改成超星批阅页 URL，把 `runDir` 改成对应本地输出目录。

示例：

```js
export const assignments = [
  {
    key: 'assignment-1',
    title: '作业一',
    runDir: 'runs/assignment-1',
    url: 'https://mooc2-ans.chaoxing.com/mooc2-ans/work/mark?courseid=YOUR_COURSE_ID&clazzid=0&id=YOUR_WORK_ID&cpi=YOUR_CPI&evaluation=0&from=&v=0&topicid=0',
  },
];
```

如果仓库是公开的，不要把真实 `courseid`、`work id`、`cpi` 提交上去。

## 基本流程

采集单个作业：

```bash
node chaoxing-grader.mjs collect --url "$MARK_URL" --out runs/assignment-1 --resume
```

按作业清单批量采集：

```bash
node collect_all_assignments.mjs
```

过滤公共图片和题目插图：

```bash
node filter_submission_assets.mjs
```

缺失图片重新下载：

```bash
node repair_missing_assets.mjs --workers 8
```

调用视觉模型评分：

```bash
MIMO_API_KEY="$MIMO_API_KEY" node chaoxing-grader.mjs vision \
  --run runs/assignment-1 \
  --rubric-file rubrics/assignment-1.md \
  --only-pending
```

生成草稿、本地相似度和报告：

```bash
node chaoxing-grader.mjs grade --run runs/assignment-1 --threshold 0.92
.venv-cv/bin/python advanced_similarity.py runs/assignment-1 --workers 8
node apply_advanced_similarity.mjs runs/assignment-1
node build_advanced_report.mjs runs/assignment-1 --replace-main
```

批量生成所有作业报告：

```bash
node report_all_assignments.mjs --workers 8
node build_report_index.mjs
node build_score_rankings.mjs
```

## 大模型雷同复核

先运行 `advanced_similarity.py` 得到候选，再用视觉模型复核候选对：

```bash
MIMO_API_KEY="$MIMO_API_KEY" node model_similarity_review.mjs runs/assignment-1 --force
node apply_advanced_similarity.mjs runs/assignment-1
node build_advanced_report.mjs runs/assignment-1 --replace-main
```

提示词模板见 `prompts/pair_review.md`。

## 早交加分

生成带早交加分的草稿和排名：

```bash
node build_submit_early_bonus_drafts.mjs
node build_early_bonus_rankings.mjs
```

默认策略：同班同作业按提交时间排序，前 20% 加 5 分，20%-50% 加 3 分，其余已交加 1 分；抄袭 0 分和未交不加，单作业封顶 100。

## 写回超星

写回前先打开 `review_report.html`、`review_report_advanced.html` 和 `grading_draft*.json` 检查。默认 `submit` 只预览，不会写回。

预览：

```bash
node chaoxing-grader.mjs submit --run runs/assignment-1 --draft runs/assignment-1/grading_draft_submit_early_bonus.json
```

确认后写回：

```bash
node chaoxing-grader.mjs submit \
  --run runs/assignment-1 \
  --draft runs/assignment-1/grading_draft_submit_early_bonus.json \
  --apply --all --allow-zero
```

批量写回所有早交加分草稿：

```bash
node submit_all_early_bonus.mjs
```

## 脱敏要求

提交到 GitHub 前至少检查：

```bash
rg -n 'tp-[A-Za-z0-9]+|sk-[A-Za-z0-9]+|courseid=\d|clazzid=\d|cpi=\d|mooc2-ans\.chaoxing\.com/.+courseid=|[0-9]{10}' .
```

本仓库 `.gitignore` 已忽略 `runs/`、`run-*`、`*.json`、`*.csv`、`*.html`、下载目录、模型输出和缓存目录。真实作业数据只应留在本地。
