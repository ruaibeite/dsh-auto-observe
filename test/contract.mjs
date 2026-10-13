/**
 * 契约测试：不依赖任何外部包，用**忠实复刻**的 waterfall 与策略逻辑钉住行为。
 *
 * 复刻对象（逐字对照线上实现）：
 * - cordis 的 waterfall：`const cbs = dispatch(...); const next = () => (cbs.shift() ?? inner)(...args);`
 *   —— 队列 shift 语义；不调用 `next()` 的监听器会否决后续。
 * - `dsh-fs-observation-policy` 的账本：`WeakMap<owner, Map<targetKey, record>>`，
 *   `owner = actor?.agent?.session`；`editIntent` 无记录 → 抛 FS_NOT_OBSERVED、
 *   记录为 absent → 抛 FS_NOT_FOUND、否则返回 `{ version }`；`writeIntent` 对未见过/确认
 *   不存在返回 `createIfAbsent`，已存在返回 `replaceIfVersion`。
 *
 * 用法：node test/contract.mjs
 */
import assert from 'node:assert/strict';

const plugin = await import('../lib/index.js');

//#region 忠实复刻的小底座
/** 与 fs 错误同形的错误。 */
class FsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FsError';
    this.code = code;
  }
}

/**
 * cordis waterfall：监听器队列 shift，最后一个参数是 next。
 * @param listeners - 注册顺序的监听器数组。
 * @param args - 除 next 之外的参数。
 * @param inner - 链尾默认行为。
 * @returns 最外层监听器的返回值。
 */
function waterfall(listeners, args, inner) {
  const queue = [...listeners];
  const next = () => (queue.shift() ?? inner)(...args, next);
  return next();
}

/** 忠实复刻 dsh-fs-observation-policy 的判定。 */
function makePolicy() {
  let observed = new WeakMap();
  const owner = (actor) => actor?.agent?.session;
  const get = (o, key) => observed.get(o)?.get(key);
  const set = (o, key, record) => {
    let byTarget = observed.get(o);
    if (byTarget === undefined) {
      byTarget = new Map();
      observed.set(o, byTarget);
    }
    byTarget.set(key, record);
  };
  return {
    /** 观察记录（策略自己也监听 fs/observed 事件）。 */
    observe(target, observation, actor) {
      const o = owner(actor);
      if (o === undefined) return;
      set(o, target.targetKey, observation);
    },
    editIntent(target, actor) {
      const o = owner(actor);
      const prior = o === undefined ? undefined : get(o, target.targetKey);
      if (o === undefined || prior === undefined) throw new FsError(`edit requires reading "${target.displayPath}" first`, 'FS_NOT_OBSERVED');
      if (prior.kind === 'absent') throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND');
      return { version: prior.version };
    },
    writeIntent(target, actor) {
      const o = owner(actor);
      const prior = o === undefined ? undefined : get(o, target.targetKey);
      return prior?.kind === 'present' ? { kind: 'replaceIfVersion', version: prior.version } : { kind: 'createIfAbsent' };
    },
    /** 供测试直接种一条“模型之前读过”的记录。 */
    seed(target, observation, actor) {
      this.observe(target, observation, actor);
    }
  };
}

/**
 * 假 ctx：`on` 的 prepend 语义与 cordis 相同（unshift / push），`emit` 同步派发。
 * @param options - `stat` 的行为与要挂载的监听器。
 * @returns 可用的 ctx 与观测记录。
 */
function makeCtx({ stat } = {}) {
  const listeners = new Map();
  const statCalls = [];
  const logLines = [];
  const order = [];
  const ctx = {
    logger: { info: (line) => logLines.push(line) },
    fs: {
      async stat(target, signal) {
        statCalls.push({ target, signal });
        return stat === undefined ? undefined : stat(target);
      }
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    on(event, listener, options) {
      const list = listeners.get(event) ?? [];
      if (options?.prepend === true) list.unshift(listener);
      else list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    emit(event, ...args) {
      order.push(`emit:${event}`);
      for (const listener of listeners.get(event) ?? []) listener(...args);
    }
  };
  return {
    ctx,
    listeners,
    statCalls,
    logLines,
    order,
    /** 跑一次 intent waterfall（把注册顺序的监听器交给复刻的 waterfall）。 */
    runIntent(event, target, actor, inner = () => undefined) {
      order.push(`intent:${event}`);
      return waterfall(listeners.get(event) ?? [], [target, actor], inner);
    }
  };
}

/** 忠实复刻 dsh-fs-observation-policy 的注册方式（异步监听器、顺序 write→edit→observed）。 */
function registerPolicy(c, policy) {
  c.ctx.on('fs/write-intent', (t, a) => Promise.resolve().then(() => policy.writeIntent(t, a)));
  c.ctx.on('fs/edit-intent', (t, a) => Promise.resolve().then(() => policy.editIntent(t, a)));
  c.ctx.on('fs/observed', (t, o, a) => {
    policy.observe(t, o, a);
  });
}

const SESSION = { id: 'session-1' };
const actor = { agent: { session: SESSION }, signal: undefined };
const target = (key = '/w/a.ts') => ({ targetKey: key, displayPath: key });
const V1 = '1:2:3:4:5';
const V2 = '1:2:3:9:9';
//#endregion

//#region A. 基线：复现线上报错
{
  const policy = makePolicy();
  const c = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  registerPolicy(c, policy);
  await assert.rejects(
    () => c.runIntent('fs/edit-intent', target(), actor),
    (error) => error.code === 'FS_NOT_OBSERVED',
    '未观察 → 策略拒绝（这就是用户看到的那条报错）'
  );
  console.log('A 基线复现未读被拒 ✓');
}

//#region B. 装上插件：同一场景通过，且顺序是「先登记、再交给策略」
{
  const policy = makePolicy();
  const c = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  registerPolicy(c, policy);
  plugin.apply(c.ctx, {});
  const intent = await c.runIntent('fs/edit-intent', target(), actor);
  assert.deepEqual(intent, { version: V1 }, '策略看到的是刚登记的真实版本');
  assert.equal(c.statCalls.length, 1, '只 stat 一次');
  assert.deepEqual(c.order, ['intent:fs/edit-intent', 'emit:fs/observed'], '登记必须发生在策略裁决之前');
  assert.equal(c.logLines.length, 1, '介入有日志，不是无声放行');
  assert.match(c.logLines[0], /version 1:2:3:4:5/);
  console.log('B 未读编辑被自动登记后放行 ✓');
}

//#region C. 已有观察记录：完全不插手（stat 都不该发生）
{
  const policy = makePolicy();
  const c = makeCtx({ stat: () => ({ type: 'file', version: V2 }) });
  registerPolicy(c, policy);
  plugin.apply(c.ctx, {});
  // 模拟「模型此前用 read 工具读过」：观察事件先到，策略与插件的镜像都记下 V1
  c.ctx.emit('fs/observed', target(), { kind: 'present', version: V1 }, actor);
  const intent = await c.runIntent('fs/edit-intent', target(), actor);
  assert.deepEqual(intent, { version: V1 }, '返回的是策略自己记的版本，不是插件补的');
  assert.equal(c.statCalls.length, 0, '已有记录时不做任何多余工作');
  assert.equal(c.logLines.length, 0, '没有介入就没有日志');
  console.log('C 已有记录时零干预 ✓');
}

//#region D. 过期保护没有被插件削弱
{
  const policy = makePolicy();
  const c = makeCtx({ stat: () => ({ type: 'file', version: V2 }) });
  registerPolicy(c, policy);
  plugin.apply(c.ctx, {});
  // 模型读过 V1，但文件现在是 V2：策略应继续拿 V1 当 CAS 基准（上层于是报 FS_STALE_VERSION）
  c.ctx.emit('fs/observed', target(), { kind: 'present', version: V1 }, actor);
  const intent = await c.runIntent('fs/edit-intent', target(), actor);
  assert.deepEqual(intent, { version: V1 }, '插件不得把基准偷偷换成当前版本');
  console.log('D 过期判定保持原样 ✓');
}

//#region E. 拿不到会话归属：不替策略决定
{
  const policy = makePolicy();
  const c = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  registerPolicy(c, policy);
  plugin.apply(c.ctx, {});
  await assert.rejects(
    () => c.runIntent('fs/edit-intent', target(), { signal: undefined }),
    (error) => error.code === 'FS_NOT_OBSERVED',
    '无 agent 归属时策略本来也不放行，插件不该伪造观察'
  );
  assert.equal(c.statCalls.length, 0);
  console.log('E 无归属时不插手 ✓');
}

//#region F. 目标不存在：按 read 的做法登记 absent
{
  const policy = makePolicy();
  const c = makeCtx({ stat: () => undefined });
  registerPolicy(c, policy);
  plugin.apply(c.ctx, { writes: true });
  await assert.rejects(
    () => c.runIntent('fs/edit-intent', target('/w/new.ts'), actor),
    (error) => error.code === 'FS_NOT_FOUND',
    '不存在的文件：edit 报「找不到」，而不是「没读过」'
  );
  const intent = await c.runIntent('fs/write-intent', target('/w/new.ts'), actor);
  assert.deepEqual(intent, { kind: 'createIfAbsent' }, 'write 仍走受保护的创建流程');
  console.log('F 缺失目标登记为 absent ✓');
}

//#region G/H. 非普通文件与 stat 失败：一律交回原流程
{
  const policy = makePolicy();
  const dir = makeCtx({ stat: () => ({ type: 'directory', version: V1 }) });
  registerPolicy(dir, policy);
  plugin.apply(dir.ctx, {});
  await assert.rejects(() => dir.runIntent('fs/edit-intent', target('/w/dir'), actor), (e) => e.code === 'FS_NOT_OBSERVED');
  assert.equal(dir.logLines.length, 0, '非普通文件不登记');

  const broken = makeCtx({ stat: () => { throw new Error('io'); } });
  registerPolicy(broken, policy);
  plugin.apply(broken.ctx, {});
  await assert.rejects(() => broken.runIntent('fs/edit-intent', target(), actor), (e) => e.code === 'FS_NOT_OBSERVED');
  assert.equal(broken.logLines.length, 0, 'stat 失败不登记、也不崩');
  console.log('G/H 非普通文件与 IO 失败都交回原流程 ✓');
}

//#region I/J. 配置与注册位置
{
  const base = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  plugin.apply(base.ctx, {});
  assert.equal(base.listeners.get('fs/edit-intent').length, 1, '默认注册 edit');
  assert.equal(base.listeners.get('fs/write-intent'), undefined, '默认不注册 write（盲覆盖不放开）');

  const both = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  plugin.apply(both.ctx, { writes: true, log: false });
  assert.equal(both.listeners.get('fs/write-intent').length, 1, 'writes: true 才注册 write');

  const off = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  plugin.apply(off.ctx, { edits: false });
  assert.equal(off.listeners.get('fs/edit-intent'), undefined, 'edits: false 时彻底不介入');

  // prepend：策略先注册，插件后注册，但插件必须排在前面（否则永远轮不到它）
  const order = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  const policyListener = () => undefined;
  order.ctx.on('fs/edit-intent', policyListener);        // 策略（线上先注册）
  plugin.apply(order.ctx, {});                          // 插件（后注册、prepend）
  assert.equal(order.listeners.get('fs/edit-intent')[0] === policyListener, false, '插件必须排在策略之前');

  // log: false 时保持安静（用 B 的场景重跑一次）
  const quietPolicy = makePolicy();
  const quiet = makeCtx({ stat: () => ({ type: 'file', version: V1 }) });
  registerPolicy(quiet, quietPolicy);
  plugin.apply(quiet.ctx, { log: false });
  assert.deepEqual(await quiet.runIntent('fs/edit-intent', target(), actor), { version: V1 });
  assert.equal(quiet.logLines.length, 0, 'log: false 不打扰');
  console.log('I/J 配置与 prepend 位置 ✓');
}
//#endregion

console.log('\nfs-auto-observe: 全部契约测试通过');
