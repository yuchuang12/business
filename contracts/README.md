# Contracts

本目录存放版本化、可机器校验的公共协议源定义。Week 1 需要冻结：

- `TenantContext v1`
- `ToolContract v1` 与 Error Taxonomy
- `AgentRun v1` / `ToolExecution v1`
- `SiteSchema v1` / `ThemeToken v1`
- `GenerativeUI v1`

## 规则

- 每个协议必须声明版本、兼容策略、规范示例和验证测试。
- 未知字段、未知组件、未知状态和不安全引用默认 fail closed。
- 任何不兼容变更必须通过 ADR，并提供迁移方案。
- 业务模块不得在本目录之外复制或重新定义公共协议。
- `packages/contracts/` 可以包含由本目录源定义生成的语言级类型，但不得成为另一个事实来源。

## 已冻结协议

- [`TenantContext v1`](tenant-context/v1/README.md)：YUC-5，经项目所有者批准并冻结为 `1.0`。
- [`ToolContract v1`](tool-contract/v1/README.md)：YUC-7，定义 Agent Tool 的统一信封、幂等、审批、审计和错误分类。
- [`AgentRun v1`](agent-run/v1/README.md) and [`ToolExecution v1`](tool-execution/v1/README.md)：YUC-8，冻结为 `1.0`。
