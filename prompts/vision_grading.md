# 视觉评分提示词

用途：把学生提交的作业截图、实验指导书摘要、已批样例分数一起发给支持图片输入的 OpenAI-compatible 模型，输出结构化评分。

核心提示词要点：

- 角色：信息安全代码审计课程助教。
- 输入：当前作业标题、实验指导书/评分标准、已批样例校准、学生截图。
- 目标：判断作业是否真正完成实验，不按截图数量机械给分。
- 评分维度：内容正确性 40 分、证据完整性 40 分、排版/可读性 20 分。
- 关键证据：实验环境或靶场、关键源码或审计结论、payload/请求/脚本、漏洞触发过程、成功结果、最终验证结论。
- 扣分点：只展示准备工作、工具启动、无关页面、关键文字不可读、截图遮挡或裁切、缺少成功验证。
- 输出：严格 JSON，字段为 `score`, `contentScore`, `evidenceScore`, `layoutScore`, `risk`, `summary`, `missing`, `extractedText`, `comment`。

脚本位置：`chaoxing-grader.mjs` 的 `analyzeSubmissionVision()`。
