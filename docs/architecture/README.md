# Architecture

本目录记录系统边界、公共协议说明、状态机、信任边界和跨模块约束。

## 冻结顺序

1. `TenantContext v1`
2. `ToolContract v1` 与 `SiteSchema/ThemeToken v1`
3. `AgentRun/ToolExecution v1` 与 `GenerativeUI v1`

公共协议一旦进入 v1 冻结状态，任何不兼容变更必须新增 ADR，并明确迁移和兼容策略。

## MVP 架构原则

- 模块化单体优先，禁止提前拆分微服务。
- Agent 只能通过 Policy + Tool Registry + Executor 操作系统能力。
- Provider 只能通过受控抽象与工作流访问。
- PostgreSQL 是关系数据与 JSON 的事实来源；Redis 仅用于缓存、幂等、锁和简单队列。
- `tenant_id` 和 `trace_id` 必须贯穿 API、Agent、Tool、Workflow、Audit 和 Provider 调用。
- Site Engine 只渲染受控 `SiteSchema`，不执行模型生成的任意代码。

## 协议说明

- [`TenantContext v1`](tenant-context-v1.md)：可信构造、传播、Repository 隔离、审计与日志边界。
