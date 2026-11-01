# dsh-smart-context

> DSH 插件：把被上下文压缩「吃掉」的历史原文找回来。

长会话撞上窗口上限时，DSH 会把早期内容压缩成摘要。摘要保留了结论，**丢掉了细节**——那个具体的报错码、那个阈值、那段被推翻的讨论。

这个插件**只读**当前会话的原始事件日志，为被遮蔽的内容建立可检索的归档，让模型在需要时把原文分页取回。

```text
压缩前：一段完整的对话
压缩后：一段摘要 + 本插件建立的归档
需要时：memory_search 找位置 → memory_open 取原文
```

**它不主动压缩、不修改会话日志、不改写模型请求。**

---
## 关于这个项目

**作者是高中生，代码水平有限（都是肥鱼和GPT做的，包括这份readme）。**

这个插件是为解决自己用 DSH 时的痛点写的，不是成熟产品。虽然写了测试、也做过真实会话验证，但**一定还有没发现的 bug**。

如果你遇到问题：

- 先看 [已知限制](#已知限制) 里有没有写
- 提 issue 时附上复现步骤和 DSH 版本
- **不要把它用在不可逆的场景上**（比如指望它找回唯一一份数据）

它现在能做的事很有限，但确实能解决一部分问题。慢慢来吧。

---

## 安装

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile desktop add github:Pepyc/dsh-smart-context
```

或者在本机的 DSH 桌面版里：**插件 → 添加插件**，填入 `github:Pepyc/dsh-smart-context`。

安装后无需重启，配置会热加载。验证方式：

```text
1. 插件列表里出现 dsh-smart-context，状态为 active
2. 工具列表里出现 memory_search 与 memory_open
```

### 卸载

```bash
dsh plugin --profile desktop remove dsh-smart-context
```

派生索引存放在 `<DSH_HOME>/smart-context/`，删除它是安全的——下次启动会从会话日志重建。

---

## 用法

### 模型侧

插件会在系统提示里加一段说明，并在每轮运行上下文的末尾附上归档目录：

```text
本会话有 3 份已归档的历史内容（宿主压缩后原文被遮蔽，可检索取回）：
- summary-v2-a1b2c3...  [摘要]  12K 字符  ===== src/archive.js (452 lines) =====
- summary-v2-d4e5f6...  [摘要]  1K 字符  ENOENT: no such file or directory, open 'config.json'
用法：memory_search 按关键词找位置；memory_open 用 id 分页取回原文。
```

模型需要早期细节时：

```js
// 1. 搜位置
const found = await tools.memory_search({ query: "超时阈值" });
// → { status: "ok", hits: [{ id, title, snippets: [{ seq, text, offset }] }] }

// 2. 取原文（可以直接跳到命中的片段）
const page = await tools.memory_open({ id: found.hits[0].id, seq: found.hits[0].snippets[0].seq });
// → { status: "ok", parts: [...], nextCursor: "..." }
```

### 人工侧

如果只是想确认插件在工作，可以在任意会话里让模型「查一下之前说过的某个具体值」，观察它是否调用 `memory_search`。

---

## 能力与边界

| 项 | 说明 |
|---|---|
| 搜索方式 | 字面子串匹配；中文连续子串、英文大小写不敏感、多词 AND、引号内为精确短语 |
| **不支持** | 同义改写、词干还原、正则、语义相似 |
| 多词无结果时 | 自动降级为逐词分别匹配，返回里标 `relaxed: true` |
| 单条归档最多返回 | 5 个命中片段（可调到 15） |
| 单页原文上限 | 6000 字符 |
| 目录预算 | 1600 字符（约 800 token） |
| 归档存储 | **只存元数据与内容哈希，不存原文**；原文始终从会话日志重新读取 |

### 它不做的事

- **不做语义检索。** 想不起原词时它可能帮不上忙。
- **不替代长期记忆。** 它只管「本会话里说过什么」，跨会话的记忆需要别的工具。
- **不主动触发。** 它提供工具，需要模型自己想起来用——这确实是个短板。

---

## 已知限制

- **触发依赖模型主动性。** 实测中，模型在直接提问时通常会用，但在执行任务、需要某个具体值时不一定想得起来。
- **大归档检索有精度上限。** 单条归档超过约 200 万字符后，命中点会多到难以区分。
- **每轮有一次全量重读。** 约 185ms CPU（以 6800 事件会话计），用于保证目录新鲜。
- **中文文件名可能显示异常。** 若历史里出现过 `cat -v` 之类的输出，标题会带上乱码——这是原始数据如此，不是渲染问题。

---

## 开发

```bash
pnpm install --frozen-lockfile
pnpm run check          # 类型检查 + 229 条测试
```

离线验证脚本：

```bash
node scripts/verify-edge-cases.mjs                    # 分页边界（合成数据）
node scripts/verify-retrieval.mjs --synthetic         # 端到端检索（合成样本）
node scripts/inspect-session.mjs <会话日志路径>       # 会话结构速览
```

三个脚本都只读、不调用模型、不打印原文。

### 项目结构

```text
src/
├── archive.js       从会话事件提取被遮蔽的原文
├── store.js         索引持久化（只存元数据）
├── sync.js          增量同步
├── search.js        关键词检索
├── pagination.js    分页打开
├── directory.js     归档目录渲染
├── hint.js          系统提示里的常驻说明
├── title.js         标题提取（三层递进）
├── tools.js         两个工具的定义
└── index.js         插件入口
```

依赖方向只能向下：`archive` / `store` / `search` / `pagination` 都不接触宿主 API，所以能完全离线测试。

---



## 许可

[MIT](LICENSE)
