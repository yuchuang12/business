# Agent 原生商业平台

面向真实商家的 Agent 原生建站与基础商业平台。MVP 目标是在 6-8 周内验证：商家是否能以“对话 + 资料上传”为主要入口，在 30 分钟内完成站点生成、商品导入、预览、域名配置与发布；消费者是否愿意通过 Customer Agent 完成商品发现、比较与留资/下单决策。

## 当前阶段

Week 1 / Contracts Freeze。所有业务实现必须等待以下五个公共协议冻结：

1. `TenantContext v1`
2. `ToolContract v1`
3. `AgentRun / ToolExecution v1`
4. `SiteSchema / ThemeToken v1`
5. `GenerativeUI v1`

## 仓库结构

```text
apps/                  应用入口（Web、API）
packages/              共享业务与运行时模块
contracts/             冻结的公共协议
infra/                 部署与基础设施
docs/product/          产品范围与验收基线
docs/architecture/     架构边界与协议说明
docs/adr/              架构决策记录
tests/e2e/             Golden Path 端到端测试
tests/security/        多租户与安全测试
```

## 工作原则

- 一个 Issue 只解决一个明确问题，不主动扩展范围。
- 公共 Contract 变更必须先提交 ADR 并获得批准。
- 所有业务数据访问必须携带 `TenantContext`。
- LLM 不得直接写数据库、调用 Provider SDK 或执行任意 Shell/网络动作。
- 高风险动作必须通过审批；所有 Tool 必须类型化、幂等、可审计、可追踪。
- MVP 采用模块化单体和单一 Provider 链路，禁止提前微服务化或多云抽象。

完整范围、需求、路线图与 Definition of Done 见 `docs/product/mvp.md`。

## Server runtime verification

The server-side Agent Runtime is implemented in Go at
`packages/agent-runtime` (package `agentruntime`). From the repository root,
run:

```sh
go test ./...
```

Frontend and contract JavaScript remain independently verified by their existing
Node test commands; the Go runtime does not load server `.mjs` modules.
