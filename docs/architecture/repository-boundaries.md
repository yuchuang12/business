# Repository Boundaries

## 模块边界

```text
Web / Merchant Console / Customer Site
                |
            API Gateway
                |
   Modular Monolith Application
   Merchant | Product | Order | Lead
   Site | Upload | Auth | Ops
                |
          Agent Runtime
 Planner -> Policy -> Tool Registry -> Executor
                |
        Tool / Workflow Layer
 Site | Commerce | Domain | Publish workflows
                |
 PostgreSQL | Redis | Object Storage | LLM
 Vector Search | Monitoring | Provider APIs
```

## 强制边界

- LLM 输出只能作为计划、参数候选或受控 UI 请求，不能直接写数据库。
- Tool Executor 是所有 Agent 副作用的唯一入口。
- Repository/DAO 必须强制接收可信 `TenantContext`，禁止可选 tenant filter。
- Domain、DNS、SSL 和 Publish 必须通过 Provider Abstraction + Workflow。
- 高风险动作先创建 `ApprovalRequest`，运行暂停，确认后使用同一幂等上下文恢复。
- 所有外部 URL 抓取执行 SSRF 防护；所有上传校验 MIME、扩展名和大小。

## 目录映射

```text
apps/web/                   Merchant Console + Customer site shell
apps/api/                   模块化单体后端
packages/contracts/         语言级生成物或共享类型（源定义仍在 /contracts）
packages/agent-runtime/     Go server runtime: Planner、Policy、Executor
packages/tools/             typed Tool 实现
packages/workflow/          发布、域名等长流程
packages/commerce/          Product、Cart、OrderIntent、Lead
packages/site-schema/       SiteSchema 解析与校验
packages/site-engine/       Schema -> React Renderer
packages/ui/                Generative UI 组件
packages/knowledge/         Parser、Index、Search
packages/provider-sdk/      受控 Provider adapter
infra/                      本地、staging、CI/CD 与可观测性
```
