# TenantContext v1

- Contract version: `1.0`
- Schema: `tenant-context.schema.json`
- Status: frozen
- Related issue: YUC-5
- Decision record: `docs/adr/0003-tenant-context-v1.md`

`TenantContext` 是由可信入口构造并在进程内、队列消息和工作流状态间传递的安全上下文。它不是 API、模型或 Tool 业务输入的一部分；调用方提供的同名字段没有授权意义，也不得覆盖此对象。

## 字段

| 字段 | 必填 | 语义与校验 |
| --- | --- | --- |
| `schema_version` | 是 | v1 固定为 `1.0`。 |
| `tenant_id` | 是 | 认证后解析出的租户标识；3-128 个安全字符。 |
| `actor_id` | 是 | 发起动作的用户、匿名会话或服务主体标识；Agent 代用户执行时仍保留原始 actor。 |
| `actor_type` | 是 | `user`、`customer_session` 或 `service_principal`。 |
| `roles` | 是 | 非空、去重、最多 8 项；actor 类型与角色组合由 Schema 约束。 |
| `scopes` | 是 | 非空、去重、最多 32 项；仅接受 v1 注册表中的权限。最终授权同时检查 scope、资源归属和动作策略。 |
| `trace_id` | 是 | W3C 兼容的 32 位小写十六进制 trace id，全链路原样传播。 |
| `request_origin` | 是 | 可信入口类型与入口生成的 `request_id`。 |
| `site_id` | 否 | 当前站点上下文；使用前必须在 `tenant_id` 下重新解析归属。 |
| `project_id` | 否 | 当前项目上下文；使用前必须在 `tenant_id` 下重新解析归属。 |

`roles` 表示业务身份，`scopes` 表示当前已授权能力。角色不能替代 scope 检查，scope 也不能替代资源的 tenant 归属检查。服务主体的 scope 必须按任务最小化，不能使用全量通配符。

## 规范行为

1. API Gateway 或受信任的内部任务入口从已验证凭证、租户成员关系和受控路由构造上下文。
2. `tenant_id`、actor、roles、scopes 和 origin 不得来自请求 body、模型输出、Tool input 或 Provider 回包。
3. Agent Runtime、Tool Executor 和 Workflow 把上下文作为独立参数传播；模型只能生成业务 input。
4. Repository/DAO 必须要求显式上下文，并把 `tenant_id` 注入每次业务读写；禁止无租户版本的方法。
5. `site_id`、`project_id` 和所有业务资源引用必须在上下文租户下解析。跨租户引用对外按“不可见资源”失败，对内留下审计原因。
6. 缺失、Schema 无效、actor/role 不一致、未知 scope 或资源归属不一致时一律拒绝执行，不能回退到默认租户或系统权限。
7. 长工作流恢复时，持久化快照只用于审计；执行前必须重新解析主体状态和授权，继续沿用同一 `trace_id`。

具体传播、信任边界、日志规则和 Repository 约束见 `docs/architecture/tenant-context-v1.md`。

## 版本与兼容

- v1 消费者必须按 `schema_version` 选择精确 Schema；不认识的版本或字段 fail closed。
- 文案、示例或不改变验证/语义的修正可更新补丁说明，不改变 `schema_version`。
- 新增可选字段、role、scope 或 origin 会改变旧消费者的验证结果，必须发布新的 minor Schema（例如 `1.1`），并显式协商支持版本。
- 删除字段、增加必填字段、收紧既有值、改变授权或传播语义属于不兼容变更，必须新增 major 版本和 ADR，并提供迁移窗口。
- 已持久化的审计快照永远按其声明版本解释，不原地重写。

## 示例与测试

- `examples/merchant-user.json`：商家用户上下文。
- `examples/anonymous-customer.json`：匿名消费者会话上下文。
- `examples/service-workflow.json`：内部工作流服务主体上下文。
- `tests/contracts/tenant-context-v1.test.mjs`：Schema 正反例、身份字段防覆盖和跨租户拒绝的可执行契约测试。
