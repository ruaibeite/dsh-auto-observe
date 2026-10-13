/**
 * @ruaibeite/dsh-auto-observe — 让「用 bash 看过、没用 read 工具读过」的文件也能编辑。
 *
 * ## 它解决的是什么
 *
 * `dsh-fs-observation-policy` 要求模型**先读后改**。但只有少数通道会登记观察记录
 * （`read` 工具、成功的 `write`/`edit`、读图片），而模型查代码时习惯用 `bash`
 * （`sed -n`、`awk 'NR>=…'`、`cat`、python 脚本）——那条路**不会**登记。结果就是
 * 「明明看过内容，却被拒绝：file has not been read」。实测数据（一个真实会话）：
 * 1186 次 bash 对 114 次 read，4 次编辑被拒，全部发生在「之前只有 bash 看过」的文件上。
 *
 * ## 它怎么做（以及为什么不是「直接放行」）
 *
 * 在 `fs/edit-intent` / `fs/write-intent` 这条 waterfall 上**前置**一个监听器
 * （`prepend: true`——策略的监听器不调用 `next()`，排在它后面就永远轮不到）：
 *
 * 1. 我自己也监听 `fs/observed`，维护一份与策略同构的镜像账本（按会话对象 → targetKey）；
 * 2. 目标**已有**记录 → 什么都不做，直接 `next()`：过期判定（`FS_STALE_VERSION`）
 *    原样保留，绝不因为本插件而消失；
 * 3. 目标**没有**记录 → 用 `ctx.fs.stat` 取一次**真实**版本，然后按 `read` 工具的做法
 *    发出 `fs/observed`（存在 → `{kind:'present', version}`；不存在 → `{kind:'absent'}`），
 *    再 `next()` 让策略照常裁决——它于是看到「刚读过」，返回版本守卫；
 * 4. 不是普通文件、拿不到会话归属、`stat` 抛错 → 一律不插手，交回原流程。
 *
 * 说清楚代价：模型可能确实没有**看过内容**（只是知道文件存在）。这时本插件记下的观察
 * 是**关于文件的事实**（它此刻的真实版本），而不是「模型看过它」这个断言——放宽的是策略
 * 对「已读」的解释。`edit` 之所以风险可控，是因为替换仍必须**逐字匹配当前内容**，匹配
 * 不上就失败；整文件覆盖（`write`）没有这层保护，所以默认**不**放开（`writes: false`）。
 *
 * ## 组合
 *
 * 与 `@deepseek-ai/dsh-fs-local` + `@deepseek-ai/dsh-fs-observation-policy` +
 * `@deepseek-ai/dsh-tool-fs` 一起用才有意义；没有策略时它只是多一次 stat，不会改变
 * 任何写入语义（那时也没有观察记录可言）。
 *
 * @module @ruaibeite/dsh-auto-observe
 */

/** Stable Loader identity. */
const name = 'fs-auto-observe';

/** 需要的服务：只用到 `ctx.fs.stat` 与 `ctx.emit`。 */
const inject = ['fs'];

/**
 * 目标在镜像账本里的记录：字符串是版本，`'absent'` 表示确认不存在。
 * @typedef {string | 'absent'} ObservedRecord
 */

/**
 * 挂载：镜像观察事件，并在意图 waterfall 上按配置前置拦截。
 * @param ctx - 宿主插件上下文。
 * @param config - 插件配置（不导出 schema，键按需读，缺省即默认值）。
 */
function apply(ctx, config) {
  const settings = {
    /** 编辑（锚定替换）时自动登记：默认开。 */
    edits: config?.edits !== false,
    /** 整文件覆盖时也自动登记：默认**关**——盲覆盖没有逐字匹配兜底。 */
    writes: config?.writes === true,
    /** 每次介入打一行日志：默认开，安全放宽不该是无声的。 */
    log: config?.log !== false
  };

  /** 镜像账本：会话对象 → (targetKey → 记录)，与策略同构且同样弱持有。 */
  let mirror = new WeakMap();
  ctx.effect(() => () => {
    mirror = new WeakMap();
  }, 'fs-auto-observe mirror teardown');

  /** 观察记录归属：策略用的是 `actor.agent.session`，这里必须一致，否则账本对不上。 */
  const ownerOf = (actor) => actor?.agent?.session ?? undefined;

  /** 记下一条观察（只认策略也认得的形状）。 */
  const note = (target, observation, actor) => {
    const owner = ownerOf(actor);
    const key = target?.targetKey;
    if (owner === undefined || typeof key !== 'string') return;
    let byTarget = mirror.get(owner);
    if (byTarget === undefined) {
      byTarget = new Map();
      mirror.set(owner, byTarget);
    }
    byTarget.set(key, observation?.kind === 'present' ? observation.version : 'absent');
  };

  ctx.on('fs/observed', (target, observation, actor) => {
    note(target, observation, actor);
  });

  /** 打日志：宿主 logger 优先，退回 console，两者都没有就安静。 */
  const report = (kind, target, info) => {
    if (!settings.log) return;
    const line = `[fs-auto-observe] ${kind} target observed on demand: ${target.displayPath} (${info})`;
    const logger = ctx.logger;
    if (logger !== undefined && typeof logger.info === 'function') logger.info(line);
    else if (typeof console !== 'undefined' && typeof console.info === 'function') console.info(line);
  };

  /**
   * 生成一个意图监守：只在「镜像里没有任何记录」时补一次真实观察，然后一律交回 waterfall。
   * @param label - 日志里用的动作名。
   * @returns waterfall 监听器。
   */
  const guard = (label) => async (target, actor, next) => {
    const owner = ownerOf(actor);
    // 拿不到会话归属时不插手：策略此时本来也不会放行，替它决定就成了伪造。
    if (owner === undefined) return next();
    if (mirror.get(owner)?.get(target?.targetKey) !== undefined) return next();
    let info;
    try {
      info = await ctx.fs.stat(target, actor?.signal);
    } catch (error) {
      return next();
    }
    if (info === undefined) {
      ctx.emit('fs/observed', target, { kind: 'absent' }, actor);
      report(label, target, 'absent');
      return next();
    }
    if (info.type !== 'file') return next();
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, actor);
    report(label, target, `version ${String(info.version)}`);
    return next();
  };

  // prepend 是必须的：策略的监听器不调用 next()，谁排在它后面谁就永远不执行。
  if (settings.edits) ctx.on('fs/edit-intent', guard('edit'), { prepend: true });
  if (settings.writes) ctx.on('fs/write-intent', guard('write'), { prepend: true });
}

export { apply, inject, name };
