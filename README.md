# dsh-commander

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 **AgentTeams** 加一层「指挥官」监督协议：决策者模型制定计划、给不同模型的成员分配任务，成员定期汇报，决策者把汇报压缩成**决策简报**交给人类，由人类决定下一步方向。

本仓库当前包含一个插件包：

```
dsh-commander/           # 插件本体（host 半侧 + 浏览器半侧 + 测试）
├── lib/index.js         # 系统提示段、commander_brief / commander_roster 工具、名册路由
├── lib/client.js        # 输入框上方的「编队」启动器（浏览器 bundle）
├── test/                # 确定性单元测试（不调模型）
├── cordis.patch.yml     # bundle patch（安装后自动进组合）
└── README.md            # 用法、配置、实验结论
```

## 它解决什么

AgentTeams 本身已经提供成员、任务 DAG、邮箱与 Web 面板，但没有「定期向人类汇报、由人类决定方向」的契约。本插件补上这一层：

- **Commander protocol**：系统提示里的固定协议段（六段式决策简报、汇报节奏、强制方向门禁、质量链边界）；
- **`commander_brief`**：读团队状态 + 队长邮箱，只显示上次简报之后的新汇报；
- **`commander_roster`**：把模型名册原样交给决策者，避免猜错模型 id；
- **「编队」按钮**：在输入框上方可视化编辑目标、成员角色、职责与模型，生成结构化指令（不绕过计划审批）。

## 安装

参见 [dsh-commander/README.md](dsh-commander/README.md#安装)。简述：

```sh
dsh plugin --profile <profile> add <本机路径>/dsh-commander
```

或在 DSH 的**插件**页 → **添加插件**，粘贴本仓库 `dsh-commander` 目录的绝对路径。

依赖：`@nanmicoder/dsh-agent-teams`（先安装）。本插件零运行时依赖。

## 测试

```sh
node dsh-commander/test/brief.test.cjs    # 47 项：协议段、工具 schema、简报解析、名册路由
node dsh-commander/test/client.test.cjs   # 25 项：bundle 注册、插槽注入、指令内容
```

两者都不调模型、不联网。CI 见 `.github/workflows/test.yml`。

## 许可

MIT，见 [LICENSE](LICENSE)。
