# 雷同复核提示词

用途：对本地 SIFT/AKAZE/哈希算法命中的候选相似图片进行大模型二次复核，减少把同一实验模板误判为抄袭。

核心提示词要点：

- 角色：信息安全课程作业相似度复核模型。
- 输入：候选算法指标、两名学生命中截图、OCR/视觉摘要。
- 判 `confirmed`：同一张照片或截图经过缩放、裁剪、压缩、改文件名；或背景、拍摄角度、窗口内容、随机值、私有 token、文件名、时间、错误信息等关键证据高度一致。
- 判 `ignore`：只是相同实验模板、相同靶场后台、相同工具界面、相同日志格式，且 IP、URL、数字、token、账号、时间、路径、响应内容等关键细节不同。
- 判 `suspected`：图像接近但关键差异看不清，或只局部相同，无法可靠确认。
- 输出：严格 JSON，字段为 `verdict`, `confidence`, `sameImage`, `sameCoreEvidence`, `templateSimilarityOnly`, `sharedEvidence`, `differences`, `comment`。

脚本位置：`model_similarity_review.mjs` 和 `chaoxing-grader.mjs` 的 `pair-review` 模式。
