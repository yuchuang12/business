# AI 工程团队协作规则

## 开工前必读

1. 阅读 `docs/product/mvp.md`。
2. 阅读 `docs/architecture/` 与 `contracts/` 中所有与当前 Issue 相关的文件。
3. 确认当前 Issue 的允许目录、验收标准、依赖和公共协议版本。

## 统一规则

1. 一个 Issue 只解决一个明确问题，不主动扩大 scope。
2. 修改公共 Contract 必须提出 ADR 或 blocker，未经批准不得直接修改。
3. 所有新逻辑必须包含测试；P0 流程必须有 E2E 或明确的测试覆盖计划。
4. 不得直接向主分支推送；本地仓库任务提交到独立分支并交由 Reviewer 审查。
5. 任何 Agent Tool 必须具有 typed input/output、TenantContext、幂等、审计与统一错误分类。
6. 不允许用临时 hardcode 掩盖协议问题。
7. 发现需求冲突时停止相关实现，记录 blocker，不自行决定产品方向。
8. 优先简单、可靠、可测试的实现，不做超出 MVP 的抽象。

## 目录所有权

| 角色 | 主要目录 | 禁止事项 |
| --- | --- | --- |
| Architect | `docs/`、`contracts/` | 不写大量业务实现；协议变更必须有 ADR |
| Backend | `apps/api/`、`packages/commerce/` | 不得修改 SiteSchema |
| Agent Runtime | `packages/agent-runtime/`、`packages/tools/`、`packages/workflow/` | 不得绕过 Tool 层 |
| Site Engine | `packages/site-schema/`、`packages/site-engine/` | 不得生成任意运行时代码 |
| Frontend | `apps/web/`、`packages/ui/` | 不得自行定义公共协议 |
| Knowledge/RAG | `packages/knowledge/` | 不得修改 Product 核心模型 |
| DevOps | `infra/` | 不得重构业务代码 |
| QA Reviewer | 全仓只读 + `tests/` | 不承担主要 Feature |

跨模块改动必须在 Issue 中列出影响面，并由 Architect 或 Reviewer 认可。

## Definition of Done

- Acceptance Criteria 全部通过。
- 单元、集成与必要的 E2E 测试通过。
- 无跨租户访问风险。
- 新 Tool 满足 typed schema、幂等、审计与错误分类要求。
- 新 Provider 提供 mock/fake，CI 不访问真实云资源。
- 文档、Contract 与 ADR 已同步更新。
- 输出改动文件、测试结果、已知风险和后续依赖。
