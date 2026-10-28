# dsh-commander

给 DeepSeek Harness 的 **AgentTeams 加一层「指挥官」监督协议**的插件：决策者模型做计划、给不同模型的成员派活，成员按节奏向决策者汇报，决策者把汇报压缩成决策简报交给**你**，等你定方向再继续。

它不是另一个团队框架。团队引擎（可续聊成员、异构模型路由、任务 DAG、成员↔队长邮箱、Web 活动面板）全部复用已安装的 [`@nanmicoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams)，本插件只补上「谁向谁汇报、什么时候必须停下来问你」这一层。

## 它解决了什么

原团队插件里，队长（captain）会自己一路推进到底，只在开始前有一次计划审批。你想要的「决策者定期向你汇报、由你决定下一步」不是它的内建契约。本插件的做法：

| 缺口 | 本插件的补法 |
|---|---|
| 队长不一定会汇报 | 系统提示里注入固定的 **Commander protocol** 段（顺序 118，紧跟 AgentTeams 的队长协议 117） |
| 「定期」没有定义 | `reportEvery` 配置：每 N 个触发事件（成员汇报 / 任务完成 / 阻塞）必须开一次简报 |
| 汇报格式随意 | 简报强制六段式：进展 / 阻塞与风险 / 成员状态 / 选项 / 我的建议 / **需要你决定** |
| 谁能决定方向 | `requireDirection: true` 时，未得到你的明确选择前**不得**开始执行阶段 |
| 成员用哪个模型靠猜 | `roster` 配置是你的模型名册，工具 `commander_roster` 返回最终生效值（已 trim、已兜底），队长不会瞎猜 model id |
| 成员汇报散落在邮箱里 | 工具 `commander_brief` 读取团队状态 + 队长邮箱，聚合成紧凑摘要，并只显示**上次简报之后的新汇报** |

## 安装

### 方式 A：Web GUI（推荐）

在 DSH 的 **插件** 页 → **添加插件**，粘贴本仓库 `dsh-commander` 目录的**绝对路径**（你 clone/解压到哪里就填哪里）：

```
<本机路径>/dsh-commander
```

安装向导会先 `inspect` 这个 spec（读取 `package.json`，确认它声明了组合包 patch），然后安装并提示**立即启用**。启用后本插件立刻出现在组合里；desktop profile 的界面改动可能需要刷新页面。

### 方式 B：CLI

```sh
dsh plugin --profile desktop add <本机路径>/dsh-commander
```

注意：desktop profile 由 Electron 应用独占，CLI 只能对它做 `dsh plugin`，不能 `--dump-config` / 直接启动。直接在沙箱里手写 `~/.dsh/profiles/desktop/` 会被文件策略拒绝（`EPERM`），所以要么走 GUI 插件页，要么在用户终端里跑上面的 CLI。

### 依赖

必须先有 `@nanmicoder/dsh-agent-teams`（本机已安装）。本插件**零运行时依赖**：不 import 任何包，只读团队状态文件，因此不会被 profile 的模块解析顺序影响。

## 配置：模型名册（你的核心控制点）

编辑 profile 的 `cordis.patch.yml`，覆盖 `commander` 行的 config（patch 层优先级高于组合包默认值，所以会覆盖 `cordis.patch.yml` 里的默认名册）：

```yaml
- id: commander
  name: dsh-commander
  config:
    reportEvery: 2          # 每 2 个触发事件汇报一次
    requireDirection: true  # 没你的明确方向不得开工
    maxReportChars: 1200    # 单条成员汇报在简报里的截断长度
    roster:
      - name: architect
        role: 方案设计
        provider: deepseek-official
        model: deepseek-v4-pro
        brief: 负责拆解、架构与验收标准
      - name: implementer
        role: 编码实现
        provider: deepseek-official
        model: deepseek-flash
        reasoning_effort: max
        brief: 按方案实现，跑通验证命令后再汇报
      - name: reviewer
        role: 审查复核
        provider: deepseek-official
        model: deepseek-flash
        brief: 挑毛病、验证据，不重写别人的实现
```

字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | 成员名（唯一、小写）；条目缺名字会被静默丢弃 |
| `role` | 否 | 角色说明，会进入简报；省略时按 `member` 处理 |
| `provider` | 否 | LLM provider route，例如 `deepseek-official` |
| `model` | 否 | 模型 id，例如 `deepseek-v4-pro`；省略则继承队长的模型 |
| `reasoning_effort` | 否 | 思考强度，目标模型支持的档位，或 `default` |
| `brief` | 否 | 一句话职责，队长会参考它派活；省略时为空 |

其他配置键：

| 键 | 默认值 | 含义 |
|---|---|---|
| `stateDir` | `.agent-teams` | 团队状态目录名（与 AgentTeams 的 `stateDir` 保持一致，改一个必须改另一个） |
| `protocol` | `''` | 追加到 Commander protocol 段末尾的「Operator notes」，用来加你自己的强制语 |
| `reportEvery` | `2` | 每 N 个触发事件（成员汇报 / 任务完成 / 阻塞）必须开一次简报 |
| `requireDirection` | `true` | 未得到你的明确选择前不得开始执行阶段 |
| `maxReportChars` | `1200` | 单条成员汇报进简报时的截断长度 |

配置收敛是**防御性**的：`provider`/`model` 会 trim，`role` 缺省兜底为 `member`，`brief` 缺省为空，没有 `name` 的行直接丢弃，`reportEvery` 非数字回退为 `2`——畸形配置只会降级，不会让 profile 启动失败。

> 名册里写错 model id 会让成员创建失败。这正是把名册做成配置而不是让模型即兴发挥的原因：改一处、立刻看简报里回显的 route 是否正确。工具返回的 route 与你在配置里写的一致（已 trim、已兜底），队长拿到的就是最终生效值。
>
> 其他可用模型取决于你在 profile 里配置的 provider（本机 `deepseek-official` 提供 `deepseek-flash` / `deepseek-v4-pro`；`volcark` 的豆包条目当前只声明了生图模型，不适合当文本成员）。

## 用起来是什么样

正常聊天里直接给目标即可，例如：

> 用 Agent Teams 做这件事：……。你是决策者，按名册给每个人派活，做完一个阶段给我决策简报，等我定方向再继续。

队长（决策者）会：

1. **INTAKE** — 复述目标、列出需要你拍板的问题；
2. **PLAN** — 出成员名单（含每个角色分配到的 provider/model 及理由）+ 任务 DAG + 验收标准，走 AgentTeams 的计划审批流程；
3. **DELEGATE** — 派任务，并告诉成员「做完 X 后汇报什么、卡住怎么报」；
4. **SUPERVISE** — 收成员汇报，每 `reportEvery` 个触发事件（或遇到阻塞/范围变更）就调 `commander_brief`；
5. **DECISION BRIEF** — 按六段式给你简报，**以「需要你决定：」结尾**；
6. **GATE** — 停下来等你。`requireDirection: true` 时它不会自己往下走；
7. **CLOSE** — 全部任务终态后交付结果。

你在中途也可以直接干预，例如「第 2 组先停下」「换个模型试试」「范围缩到只做后端」——协议要求它把这些当作方向变更，并在下一次简报里确认。

### 你能看到什么

- **输入框上方的「编队」按钮**（v0.4.0 起）：见下一节；
- **Web 会话页头的 Agent Teams 入口**：成员列表（状态、模型）、共享任务看板、点进成员会话看它具体干了什么；
- **决策简报**：在聊天流里，由决策者模型输出，格式固定，一屏以内；
- **成员真实汇报原文**：在成员会话里，或由 `commander_brief` 摘要带出。

## 编队按钮（客户端 UI）

位置：**输入框卡片上方**（插槽 `conversation.input.dock`，整宽条目）。点一下弹出配置面板：

| 控件 | 作用 |
|---|---|
| 用团队 / 不用团队 | 先选要不要开团队 |
| **本次任务目标** | 一段自由文本，写进指令开头（例：完成论文实验结果部分） |
| 成员行 | **角色**（编码实现/建模分析/论文写作/方案设计/审查复核/资料检索/自定义）、**模型**（名册模型 / 继承队长 / 自定义 `provider/model`）、**这个 agent 具体干什么**（一行职责，写进指令）、× 删除；「+ 加一个成员」最多 8 个 |
| 质量链 | 普通（1 段）/ 三段（实现→检验→**复核**）/ 五段（规格→实现→检验→复核→集成） |
| 汇报节奏 | 每 1 / 2 / 3 个触发事件给一次决策简报 |
| 只讨论，先不开工 | 勾选后指令改为「先给方案和问题，等我确认再执行」 |
| 指令预览 | 实时显示将要插入的全文 |
| **插入指令 / 插入并发送** | 插入草稿 / 插入并请求提交（宿主没暴露提交动作时提示按 Enter） |
| **一键决定** | 让 AI 判断该不该开团队、怎么开 |

指令会把「目标 → 每个成员的角色与职责及模型 → 质量链 → 汇报节奏 → 汇总要求」组织成一段话，其中明确要求：**每名成员完成后向决策者汇报「做了什么、产出在哪、卡在哪」，决策者收齐后汇总成一份交付给你，并说明每个人的贡献。**

### 关于「对话决策者 / 对话成员」

- **对话决策者**：就是主输入框。这个会话里的模型本身就是决策者，不需要第二个聊天面板；
- **对话某个成员**：在会话页头的 AgentTeams 面板里点该成员，进入其成员会话直接输入（走成员会话，不经过邮箱）；
- 面板里的「只讨论，先不开工」适合开工前和决策者对齐方案。

数据来源与记忆：
- 面板启动时请求 **`GET /plugins/dsh-commander/catalog`**（宿主路由，带连接鉴权），拿到 `roster`——和 `commander_roster` 工具**同一份配置**，所以面板不会和名册漂移；路由不可用时回退到内置默认，功能不中断；
- 上次的编队（目标/成员/职责/角色/模型/质量链/汇报节奏）存在 **localStorage**，下次打开直接复用。

设计边界（重要）：
- **它只生成指令，不建队**。团队仍然走正常流程：模型出计划 → 你在面板点「确认并启动团队」；
- 插入用 `inputActions.insertText`，失败时回退到对 Lexical 编辑器的 `execCommand('insertText')`；都失败时面板里显示提示，而不是静默丢弃；
- 面板与宿主路由都是插件代码：**宿主半侧改动需要重启，客户端改动需要刷新页面**（软链安装时 HMR 不会重建 bundle）。

## 工具

| 工具 | 谁用 | 作用 |
|---|---|---|
| `commander_brief` | 决策者 | 读团队状态 + 队长邮箱，返回成员/任务/新汇报摘要，并记录「本次简报已覆盖哪些汇报」，写 `.agent-teams/<team>/commander-brief.json` |
| `commander_roster` | 决策者 | 返回配置的模型名册（已 trim、已兜底），供创建成员时使用 |

两个工具都注册在全局工具表（与 `agent_teams_*` 一致），只在配置了 AgentTeams 的会话里才有意义。

## 验证

```sh
# 确定性单元测试（不调模型）：47 项断言，覆盖协议段（含质量链边界）、两个工具的
# schema、真实字段形态的简报解析、增量汇报、状态缺失降级、畸形配置收敛，
# 以及浏览器名册路由（200/405/鉴权分支）
node dsh-commander/test/brief.test.cjs

# 客户端 bundle 桩测试（25 项）：模块注册、插槽注入、渲染出「编队」按钮
node dsh-commander/test/client.test.cjs
```

测试自带 fixture（按 dsh-agent-teams 的 `team.json` 与 `inbox/captain.jsonl` 真实字段形态构造；核对过 0.1.25 与 0.1.27，字段同形），不依赖任何外部数据或已存在的团队。

已验证过的链路：

1. **真实 Cordis 宿主加载**：headless profile + `--patch` 挂载，协议段进入模型上下文，模型能逐字引用（退出码 0）；
2. **工具 schema 合法**：provider 端接受 `commander_brief` / `commander_roster`；
3. **端到端小团队**：建队 → 加成员 → 派任务 → 成员汇报 → `commander_brief` 返回 `members=1, tasks=1, reports=1` → 删队（退出码 0）；
4. **包名安装**：`dsh plugin add <本地路径>` → `bundle` 自动进组合 → 配置名册回显 `deepseek-official/deepseek-v4-pro`（退出码 0）；
5. **desktop profile 实装**：装进你正在用的 desktop profile，热加载后系统提示含 Commander protocol 段；改 `cordis.patch.yml` 的名册后下一轮即生效；
6. **指挥官团队实跑（对照 A，2 成员普通任务）**：`architect`（deepseek-v4-pro）核 README↔实现一致性 → `reviewer`（deepseek-flash）独立复核并亲跑单测，双双 PASS；`commander_brief` 正确聚合两条汇报并识别为「2 new」；
7. **指挥官团队实跑（对照 B，3 成员质量链）**：同一套工具下跑 5 段质量链（规格→实现→检验→复核→集成），检验者不引用实现者测试代码独立跑出 64 条断言全绿，复核 verdict=pass、0 findings。结论见下文「实验结论」。

复现脚本在 `_smoke/`（需要临时 profile 与 API key，非日常使用）。

## 实验结论：什么时候用质量链

2026-10-28 做过一次对照实验：同一插件、同一批工具，A 组用 2 成员普通 `work` 任务，B 组用 3 成员五段质量链（requirements → implementation → verification → review → integration）。

| | A 组（2 成员 / 2 普通任务） | B 组（3 成员 / 5 质量任务） |
|---|---|---|
| 独立验收证据 | 无（只跑实现者自己的测试） | 验者自建 64 条断言，0 引用实现者测试代码 |
| 抓到的实现缺陷 | 0 | 0（实现一次重试后就是对的） |
| 规格级真实风险 | 未暴露 | 4 条（>2^53 精度、JS 数字键序规范化、BOM、-0/1.0 文本规范化） |
| 事故 | 无 | 1 次成员上下文耗尽（已用「分块落盘」修复） |

**结论：细分角色的价值在「证据强度」与「风险显性化」，不在「抓 bug」。** 由此定下边界，已写进协议段：

| 任务类型 | 建议链 |
|---|---|
| 高风险（线上代码、契约、跨模块） | 5 段：requirements → implementation → verification → review → integration |
| 中小任务 / 内部工具 | 3 段：implementation → verification → **review**（集成可选） |
| 只读核查 / 文档一致性 | 1 个 work 任务 → review |

> **复核不可省（v0.4.1 修正）**：跑对照测试时发现，早先写的「3 段 = 实现→检验→集成」会让团队卡在 `blocked: completed implementation has no passing review`——这套引擎的交付门禁要求任何 implementation 都有 passing review。协议段现在明确写着「review 是必须的，缺它交付永远 blocked」。

两条来自真实事故的经验（也已在协议段里）：
- **给成员派实现任务时必须写明「分块落盘」**：先读你需要的那一节规格，落一个文件，再继续。一次读完整份规格再一次性产出多个文件的成员会耗尽上下文；
- **检验/复核类任务允许写证据目录**（如 `t3-verify/`）：在任务描述里点名该目录即视为允许，但禁止改实现文件；
- **分歧走 findings 与汇报，不走自由讨论**：成员有异议就记录成 finding 或汇报，由决策者裁决——比让成员互相「开会」更可审计，也省 token。

## 已知限制

- **不是新的团队引擎**：成员创建/调度/中断仍由 AgentTeams 决定；本插件只加协议与工具。
- **协议是提示词约束**：模型仍可能违背格式或忘记调 `commander_brief`。想让汇报更硬，可把 `reportEvery` 调到 1，或在 `protocol` 里追加你自己的强制语。
- **简报只读邮箱最后 20 条**：`commander_brief` 读取队长邮箱最新的 20 条记录。单次简报周期内新增汇报超过 20 条时，更早的会被截断（不是丢失——原文仍在 `inbox/captain.jsonl` 里）。长任务建议把 `reportEvery` 调小、多开简报周期。
- **名册是静态配置**：运行中换模型需要改 profile 配置（或让队长用 `agent_teams_reassign_task` 转派给已有成员）。
- **desktop profile 归 Electron 独占**：安装与启用走 GUI 插件页或用户终端里的 `dsh plugin`。
- **只有单进程、单机**：与 AgentTeams 相同的边界，跨机器协作不支持。

## 卸载

GUI 插件页 → 找到 `dsh-commander` → 卸载；或：

```sh
dsh plugin --profile desktop remove dsh-commander
```

卸载后协议段与两个工具一起消失，AgentTeams 回到原来的行为。
