# Security Tests

最低覆盖：跨租户读取/写入、伪造 TenantContext、Tool 越权、审批绕过、SSRF、恶意上传、Secret 泄露、模型伪造商品与价格、外部 Provider 重放。

## P0 Golden Path security

Run the deterministic security E2E suite from `business/`:

```sh
node --test tests/security/golden-path-p0.test.mjs
```

The suite covers cross-tenant reads/writes, unauthorized and hostile Tool
requests, redacted correlated denial responses, approval binding and replay,
and GenerativeUI validation/non-execution. It uses only in-memory fixtures and
fake providers; it does not access cloud resources or real credentials.
