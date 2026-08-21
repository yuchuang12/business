# Tests

- `e2e/`: 从空账号到站点上线与 Customer Agent 的 Golden Path。
- `security/`: 跨租户隔离、SSRF、上传校验、权限和 Secret 泄露防护。
- `contracts/`: 公共协议的 Schema 正反例与安全不变量测试。

P0 流程必须有 E2E 或明确覆盖；Provider 测试必须使用 mock/fake，CI 不访问真实云资源。
