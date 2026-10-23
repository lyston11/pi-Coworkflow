# Common child admission and compatibility

## Goal

批次准入只作用于本包拥有的 kind：任何其它 agent 在任何批次形状里原样放行；被拒时说清限的是什么、为什么、有没有启动子进程。

## 背景与已确认缺陷

`gateFanout`（`modules/agent-kinds/index.ts`）把上游 `parallel` 批次的每一项都当成 kind 查表：

```ts
const policy = kinds.find((entry) => entry.kind === named) ?? kinds.find((entry) => entry.agent === named);
...
if (policy === undefined) return unregisteredRefusal(dispatch, snapshot);
```

因此一个普通批次（例如 `{ agent: "reviewer" }` 或 `{ agent: "trellis-check" }`）在 gate 开启时会被判成「未注册的 kind」整批拒绝。这与同文件直接派单路径的注释承诺相反：

> A name the project's table does not know is not this gate's business: the dispatch goes through untouched, exactly as it did before kinds existed.

## 需求

- R1 批次里解析不到 kind 的项**不是本包的业务**：不拒绝、不计数、不触发 fleet 读取。
- R2 一个批次里没有任何 kind 项时，整个调用在任何公开读取之前返回。
- R3 本包 kind 的判定不变：未启用 → 拒绝；未注册 → 拒绝并给注册失败原因；计数不可读 → 拒绝；超上限 → 拒绝。
- R4 拒绝的措辞必须包含：哪个 kind（同时给 agent 名）、上限、当前占用（超上限时）；并明确「本次调用没有启动任何子进程」。
- R5 混批（kind + 非 kind）时，非 kind 项不受影响，kind 项独立判定。
- R6 不新增按 workflow 名称的白名单；解码只提供「批次里有哪些名字」。

## 约束

- 只改 `modules/agent-kinds/index.ts` 的批次判定与对应测试；不动直接派单路径的语义。
- 不读取私有 runner 文件；占用仍只来自公开 `fleet` 投影。
- 不改写上游 `parallel` 的脚本。

## 验收

- [ ] 纯非 kind 批次：不拒绝、无 RPC 读取（以测试断言）。
- [ ] 混批：非 kind 项不产生拒绝理由；kind 项按各自策略判定。
- [ ] kind 超上限：拒绝，且措辞含 kind、上限、占用、「没有启动任何子进程」。
- [ ] 计数 unknown / 会话换代：仍拒绝。
- [ ] `npm test` 全绿。
