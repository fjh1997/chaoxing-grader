# OpenClaw 作业复核提示词

用途：复核“使用 OpenClaw 自动化代码审计并出具报告”类作业，避免把部署过程、终端命令或空页面误判为完成审计。

核心提示词要点：

- 区分准备步骤和核心交付：部署、SSH、内网穿透、打开 OpenClaw 只能证明环境准备。
- 高分必要证据：OpenClaw 代码审计报告、漏洞/风险列表、审计结果、具体漏洞说明、扫描或分析结论。
- 不能高分：Dockerfile、entrypoint、启动脚本、环境变量、Tomcat/Java 启动日志、普通终端代码片段、OpenClaw 空聊天页、网络错误页、登录页、无关问答页。
- 建议区间：90-100 为审计报告或漏洞列表清楚可见；75-85 为部分审计结果可见；55-65 为只有部署或工具过程；25-40 为页面打开但证据很弱；0-20 为无有效截图或完全无关。
- 输出：严格 JSON，字段为 `score`, `contentScore`, `evidenceScore`, `layoutScore`, `risk`, `summary`, `missing`, `extractedText`, `comment`。

脚本位置：`mimo_openclaw_regrade.mjs`。
