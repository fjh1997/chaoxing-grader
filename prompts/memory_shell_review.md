# 内存马作业专项复核提示词

用途：复核“内存马与代码注入审计”类作业，避免把冰蝎/Behinder 的环境变量页、目录列表或通用工具界面误判为本次实验成功。

核心提示词要点：

- 角色：信息安全代码审计课程助教。
- 实验目标：通过反序列化或等价触发链路注入 Tomcat Filter/Listener/Servlet 等内存马，并用冰蝎/Behinder 连接验证。
- 高分必要证据：本次作业可区分的内存马 URL 或路径、payload 生成或关键参数、触发请求、注入成功证据、冰蝎连接到同一 URL/路径后的控制结果。
- 不能高分：只有冰蝎界面、JRE/Tomcat 环境变量、服务器基本信息、文件管理目录、通用 `shell`/`hack` 标识、工具启动页或无法区分本次作业的路径。
- 评分护栏：只有冰蝎环境页且无可区分 URL/路径，最高 45；有可区分 URL/路径和冰蝎连接但缺少 payload/触发/注入过程，最高 65；路径、连接和触发链路较完整可 80-95。
- 输出：严格 JSON，字段为 `score`, `contentScore`, `evidenceScore`, `layoutScore`, `visibleShellUrl`, `visibleShellPath`, `visibleStrongShellPath`, `shellUrlOrPath`, `hasPayloadGeneration`, `hasTriggerEvidence`, `hasInjectionEvidence`, `hasBehinderConnection`, `onlyBehinderEnv`, `summary`, `missing`, `extractedText`, `comment`。

脚本位置：`review_memory_shell_assignment.mjs`。
