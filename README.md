# @ruaibeite/dsh-auto-observe

让「用 bash 看过、没用 `read` 工具读过」的文件也能编辑——修掉反复出现的

```
Error: cannot modify "…/index.vue": file has not been read — read the file, then retry
```

## 这个报错为什么会一直出现

`dsh-fs-observation-policy` 要求模型**先读后改**，而只有少数通道会登记观察记录：

| 通道 | 是否登记观察 |
| --- | --- |
| `read` 工具（含 `offset`/`limit` 分段读） | ✅ |
| 成功的 `write` / `edit` | ✅ |
| 读图片 | ✅ |
| **`bash`：`sed -n`、`awk 'NR>=…'`、`cat`、`python3 - <<PY`** | ❌ **不登记** |

而模型查代码时恰恰习惯用 bash。实测一个真实会话的日志：**1186 次 bash 对 114 次 read**，
其中 4 次编辑被拒，**全部**发生在「此前只有 bash 看过、`read` 次数为 0」的文件上：

| 被拒的文件 | 失败前的 `read` | 失败前的 bash（读过它） |
| --- | --- | --- |
| `docgen-ubuntu/README.md` | 0 | 5（`cat >>`、`sed -n`） |
| `web/.../clue/unassigned/index.vue` | 0 | 28（`awk 'NR>=168…'`、python 脚本） |
| `web/.../attachment/ClueAttachmentDialog.vue` | 0 | 5（`awk 'NR>=210…'`） |

也就是说：**内容明明看过，只是看的通道不算数**。模型随后只能「再读一次、重试」——
每次多一个来回，长会话里反复发生。

## 它做什么

在 `fs/edit-intent` / `fs/write-intent` 这条 waterfall 上**前置**一个监听器
（必须 `prepend`：策略的监听器不调用 `next()`，排在它后面就永远轮不到），规则只有三条：

1. 自己也监听 `fs/observed`，维护一份与策略**同构**的镜像账本（`会话对象 → targetKey`）。
   **目标已有记录 → 什么都不做**，直接交回 waterfall：所以「文件在你读过之后被改过」的
   `FS_STALE_VERSION` 保护**原样保留**，不会因为本插件而消失。
2. 目标**没有**记录时，用 `ctx.fs.stat` 取一次**真实**版本，然后按 `read` 工具的做法发出
   `fs/observed`：存在 → `{kind:'present', version}`，不存在 → `{kind:'absent'}`。
   策略于是看到「刚读过」，返回正常的版本守卫。
3. 不是普通文件、拿不到会话归属（`actor.agent.session` 缺失）、`stat` 抛错 —— 一律不插手，
   原样交回。无归属时策略本来也不放行，替它决定就成了伪造。

## 代价，说清楚

模型可能确实没有**看过内容**（只是知道文件存在）。本插件记下的观察是**关于文件的事实**
（它此刻的真实版本），而不是「模型看过它」这个断言——放宽的是策略对「已读」的解释。

- `edit`（锚定替换）**默认开**：替换仍必须**逐字匹配当前内容**，匹配不上就失败，这层
  兜底还在；过期的 CAS 基准也不再被覆盖（见第 1 条）。
- `write`（整文件覆盖）**默认关**：盲覆盖没有逐字匹配兜底，一开就等于放弃「先读后写」
  这层保护。真要开就显式写 `writes: true`，并且知道自己在放弃什么。
- 每次介入都会打一行日志（默认开），安全放宽不该是无声的。

### 一个已知边界

镜像账本从**本插件加载时**开始记录。正常路径下这没有问题：插件要重启 Harness 才生效，而重启
会同时清空策略的内存账本，两边都从零开始、不会错位。唯一的例外是在**已经读过若干文件之后**
才热启用本插件（例如在插件页里打开它）——那时这些文件的旧记录不在镜像里，本插件会为它们补登
记一次当前版本，等于把这一次的过期判定放宽了。重启一次即回到同步状态。

## 安装

```sh
./install.sh                  # 装进 desktop profile（默认）
PROFILE_NAME=web ./install.sh # 装进别的 profile
```

装完**重启 Harness**（宿主插件不像客户端插件那样热重载）。确认挂载：

```sh
dsh --profile desktop --dump-config | grep -A3 fs-auto-observe
```

与 `@deepseek-ai/dsh-fs-local` + `@deepseek-ai/dsh-fs-observation-policy` +
`@deepseek-ai/dsh-tool-fs` 组合使用；**没有策略时它只是多一次 `stat`**，不改变任何写入语义。

## 开发

```sh
node test/contract.mjs   # 零依赖契约测试
```

测试用**忠实复刻**的 waterfall 与策略逻辑（逐字对照线上实现：队列 shift 语义、异步监听器、
`WeakMap<owner, Map<targetKey, record>>` 账本、`editIntent` 的三种结果），覆盖：

- **基线复现**：不装插件时，未读编辑确实被拒（就是你看到的那条报错）；
- 装上后同一场景放行，且断言「登记发生在策略裁决**之前**」；
- 已有记录时**零干预**（`stat` 调用次数为 0）；
- 过期场景下策略仍拿旧版本当 CAS 基准（保护未被削弱）；
- 无会话归属不伪造、缺失目标登记为 `absent`、非普通文件与 IO 失败原样交回；
- `prepend` 注册位置、`writes`/`edits`/`log` 三个开关。

## License

MIT
