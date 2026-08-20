# Agent 原生商业平台 MVP

- Version: 1.0
- Delivery target: 6-8 周交付可供首批真实商家试用的 MVP
- Source: `Agent原生商业平台_MVP需求与AI工程团队执行文档_v1.0.docx`
- Status: 研发执行基线

> 任何新增需求必须先经过产品负责人批准，再进入 Issue。

## 1. 产品定义与成功标准

商家只需与 Merchant Agent 对话并上传资料，系统自动完成建站、商品导入、域名配置、发布上线与基础运营；消费者只需与 Customer Agent 对话，即可完成商品咨询、推荐、比较、留资或下单。

本项目不是传统 AI 建站器，也不是给现有网站增加聊天框。MVP 验证两个核心假设：

1. 商家能否以“对话 + 资料上传”为主要入口完成网站或商城上线。
2. 消费者是否愿意通过 Agent 完成商品发现与购买决策。

### 1.1 北极星目标

从空白商家账号开始，商家不进入复杂后台，在 30 分钟内完成：

```text
上传资料 -> Agent 生成站点 -> 导入商品 -> 预览
-> 选择域名 -> 配置并发布 -> Customer Agent 可用
```

### 1.2 MVP 指标

| 指标 | 目标 | 验收方式 |
| --- | --- | --- |
| 建站完成率 | >= 80% 测试商家可独立完成首站发布 | 端到端任务日志 |
| 建站时长 | 首次可用站点 <= 30 分钟 | 创建项目到 publish success |
| Agent 工具成功率 | 关键 Tool 调用成功率 >= 95% | ToolExecution 监控 |
| 发布成功率 | 域名或临时域发布成功率 >= 95% | 发布工作流 |
| 页面可用性 | 移动端和桌面端无阻断性布局问题 | E2E + 人工 QA |
| Customer Agent | 完成需求理解、推荐、比较、留资或加购 | 场景测试 |
| 数据隔离 | 跨租户读取为 0 | 安全测试 |

### 1.3 MVP 明确不做

- 完整拖拽式页面编辑器。
- 多云或多域名注册商并行支持。
- 复杂 ERP、WMS、物流系统。
- 复杂营销自动化和广告投放 Agent。
- 完整财务结算和税务系统。
- 插件市场和第三方开发者生态。
- 完全自由的 AI 编程建站。
- 多 Agent 自主协商式组织架构。
- 完整国际化、多币种和多语言支持。

范围原则：MVP 只支持一条可跑通的供应商链路，即一个 Domain Provider、一个 DNS/CDN Provider、一个对象存储和一个支付或留资路径。不为未来可能接入的供应商提前抽象十套实现。

## 2. 用户与 Golden Path

### 2.1 Merchant

- 创建商业站点或商城，不学习复杂建站后台。
- 上传 Logo、品牌资料、商品 Excel、PDF、产品图和参考网站。
- 通过对话描述风格、首页重点、商品分类和域名偏好。
- 查看实时预览，在确认关键动作后发布。
- 上线后通过 Agent 修改商品、调整页面并查看基础运营信息。

### 2.2 Customer

- 用自然语言描述需求，不需要理解复杂商品分类。
- Customer Agent 基于真实商品数据和知识库进行推荐。
- 通过动态 UI 查看商品卡、对比表和组合方案。
- 继续追问，最终留资、加购或下单。

### 2.3 端到端 Golden Path

```text
商家注册
  -> 创建项目
  -> 上传品牌资料 / 商品资料 / 参考站
  -> Merchant Agent 分析资料
  -> 生成 Site Plan + SiteSchema v1
  -> 渲染预览
  -> 商家通过对话修改
  -> 选择平台临时域名、已有域名或购买新域名
  -> 高风险动作确认
  -> Domain Workflow: register -> DNS -> SSL -> bind
  -> Publish Workflow
  -> Customer Agent 自动上线
  -> 消费者咨询 -> 推荐 -> 比较 -> 留资 / 加购
```

## 3. MVP 功能需求

### 3.1 商家账号与项目

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| MER-001 | 邮箱或手机号登录，创建商家租户 | P0 | 创建 tenant 与 owner 用户 |
| MER-002 | 创建站点项目 | P0 | 生成 `site_id`，默认 `DRAFT` |
| MER-003 | 名称、Logo、行业、联系方式 | P0 | Agent 可读取和修改 |
| MER-004 | 对话区 + 预览区 + 状态区工作台 | P0 | 完成全部 Golden Path |
| MER-005 | 关键操作审批卡片 | P0 | 购买域名、发布、删除等需确认 |

### 3.2 资料上传与知识抽取

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| ING-001 | 上传 PDF、Word、Excel、CSV、图片 | P0 | 单文件 <= 50 MB，失败错误明确 |
| ING-002 | 商品 Excel/CSV 自动映射 | P0 | 名称、价格、SKU、图片、描述、分类可导入 |
| ING-003 | PDF/Word 文本解析 | P0 | 生成可检索的 DocumentChunk |
| ING-004 | 参考网站 URL 抓取 | P1 | 只参考公开结构与文案，不直接复制 |
| ING-005 | 导入异步化 | P0 | 有进度、失败状态和重试 |

### 3.3 Merchant Agent

- 理解商家目标、行业、品牌调性和商品结构。
- 生成页面列表、首页 Section 顺序、Theme Token 和重点商品。
- 通过标准 Tool 建站、改版、导入商品和发布。
- 高风险操作先创建 `ApprovalRequest`，不可越权执行。
- 每次 Tool 调用携带幂等键、`tenant_id`、`actor_id` 和 `trace_id`。
- 失败时返回可理解原因，并按策略自动重试或请求人工确认。

### 3.4 Site Engine / Design System

| ID | 需求 | 优先级 | 验收标准 |
| --- | --- | --- | --- |
| SITE-001 | `SiteSchema v1` | P0 | 可版本化并通过 JSON Schema 校验 |
| SITE-002 | `ThemeToken v1` | P0 | 颜色、字体、间距、圆角、密度受控 |
| SITE-003 | 至少 12 个 Section | P0 | 包含 Hero、ProductGrid、Category、FAQ、Review、Story、CTA、Footer 等 |
| SITE-004 | 至少 5 套主题 | P0 | 极简、科技、高端、自然、活力 |
| SITE-005 | Schema -> React Renderer | P0 | 无动态代码生成即可渲染 |
| SITE-006 | 实时预览 | P0 | Agent Tool 成功后 <= 3 秒更新 |
| SITE-007 | 版本和回滚 | P0 | 每次发布生成 SiteVersion，可回退 |
| SITE-008 | 响应式 | P0 | 桌面和移动端通过基础 E2E |

### 3.5 Commerce Core

- 基础实体：Product、Variant、Category，可选 Inventory。
- 商品搜索、过滤和推荐候选查询 API。
- 最小购物车：加入、删除、修改数量。
- 订单 MVP：创建订单或购买意向单；支付只接单一 Provider，也可先使用留资路径。
- Lead：联系方式、对话摘要、意向商品和时间。

### 3.6 Customer Agent 与 Generative UI

- 理解自然语言需求并进行必要追问。
- 只基于 Product Search + RAG 推荐，不臆造商品、价格和库存。
- 支持 `product_grid`、`product_compare`、`product_detail`、`cart_summary`、`lead_form`、`confirm_action`。
- UI 必须引用真实 `product_id`，模型不得创建任意商品对象。
- 匿名会话绑定对话记录，留资后可合并到 Customer。

## 4. 域名、DNS、SSL 与发布

### 4.1 Provider 抽象

Agent 不直接依赖具体云厂商 SDK。所有外部副作用通过 Provider Abstraction + Workflow 执行，MVP 只接一条完整链路。

```text
DomainProvider
  searchDomain(query)
  quoteDomain(domain)
  registerDomain(domain, registrant, idempotencyKey)
  getDomainStatus(domain)

DNSProvider
  createZone(domain)
  upsertRecord(zone, type, name, value)
  verifyRecord(...)

SitePublisher
  publish(siteVersion)
  bindDomain(siteId, domain)
  rollback(siteVersion)
```

### 4.2 Domain Workflow

```text
SEARCHED
  -> QUOTED
  -> WAITING_USER_CONFIRMATION
  -> PAYMENT_AUTHORIZED / SKIP_IF_PLATFORM_CREDIT
  -> REGISTERING
  -> REGISTERED
  -> DNS_CONFIGURING
  -> SSL_ISSUING
  -> SITE_BINDING
  -> HEALTH_CHECK
  -> ACTIVE

failure -> FAILED_RETRYABLE / FAILED_MANUAL
```

### 4.3 强制确认动作

- 购买域名或产生真实费用。
- 修改商品售价或创建大额折扣。
- 正式发布到公开域名。
- 删除站点或批量删除商品。
- 任何不可逆操作。

### 4.4 发布模式

- 站点默认先发布到 `{siteSlug}.yourplatform.com`。
- 商家之后可绑定已有域名或通过平台购买域名。
- 平台使用多租户共享运行时，不为每个商家创建独立 ECS。
- CDN 与 SSL 由统一 Provider 自动处理。

## 5. 系统架构与核心协议

```text
Web / Merchant Console / Customer Site
                    |
                API Gateway
                    |
        Modular Monolith Application
 Merchant | Product | Order | Lead | Site | Upload | Auth | Ops
                    |
              Agent Runtime
      Planner -> Policy -> Registry -> Executor
                    |
             Tool / Workflow Layer
 Site Tools | Commerce Tools | Domain Tools | Publish/Domain Workflow
                    |
 PostgreSQL | Redis | Object Storage | LLM API | Vector | Monitoring | Providers
```

### 5.1 Week 1 必须冻结的协议

| 协议 | 作用 | 冻结要求 |
| --- | --- | --- |
| `SiteSchema v1` | 站点、页面、Section、Theme | Week 1 完成，后续变更走 ADR |
| `ToolContract v1` | Tool 输入、输出、错误、幂等 | Week 1 完成 |
| `AgentRun v1` | Agent 状态、消息、步骤、审批 | Week 1 完成 |
| `GenerativeUI v1` | Agent 返回 UI 组件协议 | Week 1 完成 |
| `TenantContext v1` | 租户隔离、actor、权限与 trace | Week 1 完成 |

### 5.2 ToolContract 基线

```json
{
  "tool": "publish_site",
  "version": "1.0",
  "tenant_id": "t_xxx",
  "actor_id": "u_xxx",
  "trace_id": "tr_xxx",
  "idempotency_key": "...",
  "input": {}
}
```

```json
{
  "success": true,
  "data": {},
  "error": null,
  "retryable": false,
  "audit_id": "audit_xxx"
}
```

### 5.3 P0 Tool 清单

| 领域 | Tool |
| --- | --- |
| Site | `create_site`, `get_site`, `update_site_meta`, `apply_theme`, `add_section`, `update_section`, `reorder_sections`, `create_page`, `publish_site`, `rollback_site` |
| Product | `import_products`, `create_product`, `update_product`, `create_category`, `search_products`, `get_product` |
| Knowledge | `upload_asset`, `parse_document`, `index_document`, `search_knowledge` |
| Domain | `search_domain`, `quote_domain`, `request_domain_purchase`, `get_domain_status`, `bind_domain` |
| Commerce | `create_cart`, `add_cart_item`, `create_lead`, `create_order_intent` |
| Ops | `get_site_metrics`, `get_agent_run`, `retry_failed_workflow` |

## 6. 核心数据模型

| 实体 | 关键字段 |
| --- | --- |
| Tenant | `id`, `name`, `status`, `plan`, `created_at` |
| User | `id`, `tenant_id`, `role`, `auth_identity` |
| Site | `id`, `tenant_id`, `slug`, `current_version_id`, `domain`, `status` |
| SiteVersion | `id`, `site_id`, `schema_json`, `theme_json`, `created_by`, `publish_status` |
| Product | `id`, `tenant_id`, `sku`, `name`, `price`, `currency`, `category_id`, `content`, `status` |
| Asset | `id`, `tenant_id`, `type`, `storage_url`, `metadata` |
| DocumentChunk | `id`, `tenant_id`, `source_id`, `text`, `embedding`, `metadata` |
| AgentRun | `id`, `tenant_id`, `agent_type`, `status`, `input`, `output`, `trace_id` |
| ToolExecution | `id`, `agent_run_id`, `tool`, `input`, `output`, `status`, `retry_count` |
| ApprovalRequest | `id`, `tenant_id`, `action_type`, `payload`, `status`, `expires_at` |
| DomainOrder | `id`, `tenant_id`, `domain`, `quote`, `provider`, `workflow_status` |
| CustomerSession | `id`, `tenant_id`, `site_id`, `anonymous_id`, `messages` |
| Lead | `id`, `tenant_id`, `site_id`, `contact`, `summary`, `intent`, `products` |

数据隔离红线：所有业务表显式携带 `tenant_id`；Repository/DAO 层必须将可信 `TenantContext` 作为强制条件。任何跨租户读取均视为 P0 安全事故。

## 7. Agent Runtime 行为规范

### 7.1 Agent Loop

```text
Input
  -> Resolve trusted TenantContext
  -> Load relevant context only
  -> Plan next action
  -> Policy check
  -> Need approval?
       yes -> ApprovalRequest -> pause
       no  -> Execute typed Tool
  -> Validate result
  -> Retry / fallback / continue
  -> Return message + optional Generative UI
```

### 7.2 禁止行为

- LLM 直接写数据库。
- LLM 直接调用云供应商 SDK。
- 未经 ToolContract 执行任意 Shell 或网络动作。
- 未经确认产生真实费用。
- 根据想象创建不存在的商品、价格或库存。
- 将上传资料无过滤地放进系统 Prompt。
- Agent 自动修改公共协议。

### 7.3 模型分层

- 轻量模型：意图分类、字段提取、简单问答和 QA。
- 主力 Coding/Reasoning 模型：建站规划、商品推荐和复杂任务。
- 强模型：架构、复杂故障和少量高难度规划。

每个 AgentRun 必须记录 token、cost、latency 和 model，支持后续模型路由优化。

## 8. 界面要求

### 8.1 Merchant Console

- 左侧：Merchant Agent 对话流。
- 右侧：实时站点 Preview。
- 顶部：项目、环境、域名和发布状态。
- 侧栏或底部：解析、生成、等待确认、发布等工作流状态。
- Agent 消息可嵌入 ConfirmAction、ThemePicker、DomainPicker 和 DiffPreview。

### 8.2 Customer Site

- 保留基础站点视觉层，Agent 是首要交互入口。
- 首页直接展示对话输入和推荐入口。
- Agent 可生成真实商品卡、商品比较和购物车摘要。
- 移动端优先；商品卡必须来自后端真实 Product 数据。

### 8.3 SiteSchema 示例

```json
{
  "siteId": "s_001",
  "theme": {
    "preset": "premium",
    "radius": "md",
    "density": "comfortable"
  },
  "pages": [
    {
      "slug": "/",
      "sections": [
        {"type": "hero", "props": {"headline": "...", "assetId": "a_1"}},
        {"type": "product_grid", "props": {"categoryId": "c_1", "limit": 8}},
        {"type": "faq", "props": {"source": "knowledge"}}
      ]
    }
  ]
}
```

## 9. 基础设施与部署

| 组件 | MVP 选择 | 说明 |
| --- | --- | --- |
| Frontend | Next.js / React | Merchant Console + Site Renderer |
| Backend | Java Spring Boot 或 Go 单体 | 模块化单体，禁止微服务化 |
| Database | PostgreSQL + pgvector | 关系数据、JSON 与 Vector |
| Cache/Queue | Redis | 缓存、幂等、简单任务队列和锁 |
| Object Storage | S3、R2、OSS 之一 | 资料与图片 |
| CDN/DNS | 固定一个 Provider | MVP 单链路 |
| LLM | OpenAI/Codex 等 API | 模型路由层隔离 Provider |
| Observability | OpenTelemetry + Sentry/Grafana 等 | `trace_id` 串联全链路 |

禁止过度设计：Kubernetes（除非现有环境强制）、Kafka/Pulsar、服务网格、几十个微服务、复杂事件溯源、自建模型推理集群、每商户独立基础设施。

## 10. 安全、审计与可观测性

- 每个 ToolExecution 写入 AuditLog。
- Secret 不明文入库，统一使用 Secrets Manager/KMS 或加密存储。
- Provider 凭证采用最小权限。
- Agent Prompt 不得输出 Secret。
- 外部 URL 抓取必须防 SSRF。
- 上传必须校验 MIME、大小和扩展名。
- 发布前进行 Schema validation、内容安全检查和基础链接检查。
- Agent、Tool 和 Workflow 必须携带同一 `trace_id`。

### 10.1 必须监控

| 指标 | 用途 |
| --- | --- |
| AgentRun success rate | Agent 稳定性 |
| ToolExecution success/retry rate | 工具故障定位 |
| Average token / AgentRun | 成本控制 |
| Publish workflow success rate | 发布健康度 |
| Domain workflow failure reason | Provider 稳定性 |
| Site generation time P50/P95 | 用户体验 |
| RAG hit / unsupported answer rate | 回答质量 |
| Cross-tenant security test | 安全红线 |

## 11. AI 工程团队

第一阶段启动 5 个核心 AI 工程师；协议稳定后再增加 Frontend、RAG 和 DevOps。不要一开始让 10 个 Agent 同时修改全仓。

| Agent | 职责 | 主要目录 | 禁止事项 |
| --- | --- | --- | --- |
| Architect | 协议、模块边界、ADR、Review | `docs/`, `contracts/` | 不写大量业务实现 |
| Backend | Tenant/Auth/Commerce/Provider | `apps/api/`, `packages/commerce/` | 不修改 SiteSchema |
| Agent Runtime | Planner/Policy/Tool/Workflow | `packages/agent-runtime/`, `packages/tools/` | 不绕过 Tool 层 |
| Site Engine | Renderer/Theme/Components | `packages/site-*` | 不自由生成运行时代码 |
| QA Reviewer | 测试、E2E、安全、PR Review | 全仓只读 + `tests/` | 不承担主要 Feature |
| Frontend | Merchant Console/Generative UI | `apps/web/`, `packages/ui/` | 不自定义协议 |
| RAG | Parser/Index/Search | `packages/knowledge/` | 不修改 Product 核心模型 |
| DevOps | CI/CD/Provider/Monitoring | `infra/` | 不重构业务代码 |

统一 Agent Instructions 见仓库根目录 `AGENTS.md`。

## 12. 推荐仓库结构

```text
apps/
  web/
  api/
packages/
  contracts/
  agent-runtime/
  tools/
  workflow/
  commerce/
  site-schema/
  site-engine/
  ui/
  knowledge/
  provider-sdk/
infra/
  docker/
  deploy/
docs/
  product/
  architecture/
  adr/
contracts/
tests/
  e2e/
  security/
```

不同 Agent 默认只修改各自负责目录。跨模块改动必须在 Issue 中列出影响面，并由 Architect 或 Reviewer 认可。

## 13. 首批 P0 Backlog

### Architecture

- ARCH-001: TenantContext v1，0.5d。
- ARCH-002: ToolContract v1 + Error Taxonomy，1d。
- ARCH-003: AgentRun/ToolExecution 状态模型，1d。
- ARCH-004: SiteSchema/ThemeToken v1，2d。
- ARCH-005: GenerativeUI v1，1d。

### Backend

- BE-001: 模块化单体和数据库 migration，1d。
- BE-002: Tenant/User/Auth，2d。
- BE-003: Product/Category 模型与 API，2d。
- BE-004: Asset/Upload API，1d。

### Agent Runtime

- AG-001: Runtime skeleton，2d。
- AG-002: Tool Registry + typed executor，2d。
- AG-003: Policy/Approval middleware，2d。
- AG-004: AgentRun tracing + audit，1d。

### Site Engine

- SITE-001: SiteSchema validator，1d。
- SITE-002: ThemeToken renderer，1d。
- SITE-003: 首批 6 个 Section，3d。
- SITE-004: 补齐 12 个 Section，3d。
- SITE-005: Site Version/Preview/Publish，3d。

### Ingestion, Tool, Domain, Frontend, Customer, QA, Ops

- ING-001/002/003: 商品导入、文档解析、pgvector 搜索。
- TOOL-001/002: Site Tools 与 Product Tools。
- DOM-001/002/003: Provider interface、真实 Provider、DNS/SSL/Bind workflow。
- FE-001/002/003: Console、Chat + Preview、Approval/Domain/Status UI。
- CUST-001/002: Customer Agent 与 Product Generative UI。
- LEAD-001: Lead form + summary persistence。
- QA-001/002/003: Golden Path、跨租户、Tool failure/retry 测试。
- OPS-001/002: OTel + 错误监控、CI/CD + staging。

## 14. 6-8 周计划

| 周期 | 目标 | 必须交付 |
| --- | --- | --- |
| Week 1 | 协议冻结 + 工程骨架 | 五大 Contract、仓库、DB、Runtime skeleton、首批 UI 组件 |
| Week 2 | 站点生成主链路 | 上传、解析、SitePlan、SiteSchema、Preview、商品导入 |
| Week 3 | Merchant Agent 可执行 | Site/Product Tools、Approval、版本和回滚 |
| Week 4 | 发布与域名 | 临时域发布、域名查询/报价/确认/注册/DNS/SSL/绑定 |
| Week 5 | Customer Agent | 检索、推荐、比较、Generative UI、Lead/Cart |
| Week 6 | Golden Path | 空账号到真实站点上线，全链路 E2E |
| Week 7 | 稳定性与安全 | 重试、审计、多租户、监控和成本 |
| Week 8 | 首批试用 | 3-5 家真实商家接入并修复真实数据问题 |

里程碑：Day 7 Contracts Freeze；Day 21 Merchant Agent 生成并修改可预览网站；Day 35 域名/发布 + Customer Agent 闭环；Day 42 Golden Path 全绿；Day 56 至少 3 家商户独立上线。

## 15. Definition of Done

所有 Issue 必须满足：

- Acceptance Criteria 全部通过。
- 相关单元测试和集成测试通过。
- P0 路径有 E2E 或明确测试覆盖。
- 无跨租户访问风险。
- 新 Tool 有 typed schema、幂等、审计和统一错误码。
- 新 Provider 有 mock/fake，CI 不访问真实云资源。
- 相关文档、Contract 和 ADR 已更新。
- Reviewer 通过且无 blocker。
- 输出已知限制和后续 Issue。

### 15.1 最终 Demo

1. 新建“高端宠物用品”商家账号。
2. 上传 Logo、品牌介绍 PDF、50 个商品 Excel、图片和参考网站。
3. 要求 Agent 创建高端、自然风格商城，重点展示狗粮和出行用品。
4. Agent 生成站点结构、文案、主题和商品区块，右侧出现可用预览。
5. 商家要求第一屏更高级，并调整狗粮与出行用品顺序，Agent 完成修改。
6. 商家要求首年预算 100 元以内的域名，Agent 返回候选和报价。
7. 商家确认后，系统在 sandbox 执行购买、DNS、SSL 和绑定。
8. 消费者描述柴犬体重、肠胃和预算，Customer Agent 返回真实商品推荐和比较卡。
9. 消费者继续追问并留资或加购。
10. 商家询问高意向客户，Merchant Agent 读取 Lead 并总结。

通过标准：以上步骤在 Staging 环境无人工改数据库、无手工改 DNS、无工程师介入即可完成。

## 16. 风险与降级

| 风险 | MVP 处理 |
| --- | --- |
| 模型设计质量不稳定 | 限制在 Design System + SiteSchema，不自由写 React |
| 商品字段脏或不一致 | Mapping UI + 错误报告 + 人工确认 |
| 域名注册失败 | 可重试；降级平台临时域名，不阻塞上线 |
| DNS/SSL 延迟 | 异步状态机，前端展示进度，不阻塞 Agent 会话 |
| LLM 幻觉商品 | 推荐只使用 `search_products` 返回的真实 ID |
| 成本失控 | 每个 AgentRun 记录 token/cost，设置路由和预算上限 |
| AI 修改冲突 | 目录所有权 + Contract Freeze + Review |
| Scope 膨胀 | 非 P0 一律进入 Post-MVP backlog |

### 16.1 Post-MVP

- 完整支付、退款和物流。
- 多云 Provider 与商家 BYOC。
- 自由编程 Widget Sandbox。
- 完整营销 Campaign Agent、复杂 CRM 和自动培育。
- 多语言、多币种。
- Marketplace / Buyer Agent 多商家比价。
- 插件市场和自动广告投放。

## 17. Multica 开工顺序

1. 建立仓库和 `docs/product/mvp.md`。
2. 创建并冻结 ARCH-001 到 ARCH-005；第一天不让所有 Agent 同时编码。
3. Contracts 合并后并行启动 Backend、Agent Runtime 和 Site Engine。
4. QA 从 Week 1 创建 E2E 骨架。
5. Week 2 启动 Frontend 和 RAG；Week 3 启动真实 Provider 与 DevOps。
6. 只合并满足 DoD 的变更，禁止“先合再修”。
7. 单 Issue 超过 token 阈值仍无结果时，转人工 Review 或切换更强模型。
8. 每周按 Golden Path 接近程度评估，不按代码量评估。

研发负责人拥有产品 scope、公共 Contract 变更、高风险 Provider/Secret 设计、MVP 验收和最终合并权限。

最终原则：让 AI 工程师并行实现已经冻结的系统，而不是并行重新发明系统。
