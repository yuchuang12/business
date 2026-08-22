package agentruntime

import "testing"

func serviceContext(tenant, actor string) TenantContext {
	return TenantContext{
		SchemaVersion: ContractVersion, TenantID: tenant, ActorID: actor, ActorType: "user",
		Roles: []string{"tenant_owner"}, Scopes: []string{"agent:run", "site:publish"},
		TraceID:       "4bf92f3577b34da6a3ce929d0e0e4736",
		RequestOrigin: RequestOrigin{Kind: "merchant_console", RequestID: "request_100"},
	}
}

func requireCode(t *testing.T, code string, err error) {
	t.Helper()
	if ErrorCode(err) != code {
		t.Fatalf("error code = %q, want %q (error: %v)", ErrorCode(err), code, err)
	}
}

func TestCreateTenantTraceLinkedRecordsAndDeduplicates(t *testing.T) {
	service := NewAgentRuntimeService(nil, nil, nil)
	context := serviceContext("tenant_a", "actor_a")
	run, duplicate, err := service.CreateRun(context, CreateRunOptions{IdempotencyKey: "run-request-0000001"})
	if err != nil || duplicate {
		t.Fatalf("first run = (%v, %v)", duplicate, err)
	}
	duplicateRun, duplicate, err := service.CreateRun(context, CreateRunOptions{IdempotencyKey: "run-request-0000001"})
	if err != nil || !duplicate || duplicateRun.AgentRunID != run.AgentRunID {
		t.Fatalf("duplicate run did not replay: (%+v, %v, %v)", duplicateRun, duplicate, err)
	}
	execution, duplicate, err := service.CreateToolExecution(context, CreateToolOptions{
		AgentRunID: run.AgentRunID, ToolName: "site.publish", ToolVersion: ContractVersion, IdempotencyKey: "tool-request-000001",
	})
	if err != nil || duplicate {
		t.Fatalf("first execution = (%v, %v)", duplicate, err)
	}
	_, duplicate, err = service.CreateToolExecution(context, CreateToolOptions{
		AgentRunID: run.AgentRunID, ToolName: "site.publish", ToolVersion: ContractVersion, IdempotencyKey: "tool-request-000001",
	})
	if err != nil || !duplicate {
		t.Fatalf("duplicate execution = (%v, %v)", duplicate, err)
	}
	if execution.TenantID != "tenant_a" || execution.TraceID != run.TraceID {
		t.Fatalf("execution lost ownership linkage: %+v", execution)
	}
	if got := len(service.Store.AuditRecords()); got != 2 {
		t.Fatalf("audits = %d, want 2", got)
	}
}

func TestRejectsInvalidAndCrossTenantContext(t *testing.T) {
	service := NewAgentRuntimeService(nil, nil, nil)
	run, _, err := service.CreateRun(serviceContext("tenant_a", "actor_a"), CreateRunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.TransitionRun(TenantContext{TenantID: "tenant_a"}, run.AgentRunID, "running", "")
	requireCode(t, "TENANT_CONTEXT_INVALID", err)
	_, err = service.TransitionRun(serviceContext("tenant_b", "actor_b"), run.AgentRunID, "running", "")
	requireCode(t, "RUNTIME_NOT_FOUND", err)
}

func TestStrictTenantContextValidation(t *testing.T) {
	valid := serviceContext("tenant_a", "actor_a")
	if _, err := ValidateTenantContext(valid); err != nil {
		t.Fatal(err)
	}
	valid.Roles = []string{"unknown"}
	if _, err := ValidateTenantContext(valid); ErrorCode(err) != "TENANT_CONTEXT_INVALID" {
		t.Fatalf("unknown role accepted: %v", err)
	}
	valid = serviceContext("tenant_a", "actor_a")
	valid.ActorType, valid.Roles, valid.RequestOrigin.Kind = "customer_session", []string{"customer"}, "merchant_console"
	if _, err := ValidateTenantContext(valid); ErrorCode(err) != "TENANT_CONTEXT_INVALID" {
		t.Fatalf("inconsistent customer context accepted: %v", err)
	}
	_, err := ParseTenantContext([]byte(`{"schema_version":"1.0","tenant_id":"tenant_a","actor_id":"actor_a","actor_type":"user","roles":["tenant_owner"],"scopes":["agent:run"],"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","request_origin":{"kind":"merchant_console","request_id":"request_100"},"unknown":true}`))
	requireCode(t, "TENANT_CONTEXT_INVALID", err)
	_, err = ParseTenantContext([]byte(`{"schema_version":"1.0","tenant_id":"tenant_a","actor_id":"actor_a","actor_type":"user","roles":["tenant_owner"],"scopes":["agent:run"],"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","request_origin":{"kind":"merchant_console","request_id":"request_100"}} {}`))
	requireCode(t, "TENANT_CONTEXT_INVALID", err)
}

func TestToolErrorTaxonomyMatchesContract(t *testing.T) {
	cases := map[string]struct {
		category  string
		retryable bool
	}{
		"TOOL_INVALID_REQUEST":            {"validation", false},
		"TOOL_UNSUPPORTED_VERSION":        {"validation", false},
		"TOOL_FORBIDDEN":                  {"authorization", false},
		"TOOL_APPROVAL_REQUIRED":          {"approval", false},
		"TOOL_APPROVAL_EXPIRED":           {"approval", false},
		"TOOL_CONFLICT":                   {"conflict", false},
		"TOOL_NOT_FOUND":                  {"not_found", false},
		"TOOL_RATE_LIMITED":               {"rate_limit", true},
		"TOOL_PROVIDER_FAILED":            {"provider", true},
		"TOOL_TIMEOUT":                    {"timeout", true},
		"TOOL_INFRASTRUCTURE_UNAVAILABLE": {"transient_infrastructure", true},
		"TOOL_INTERNAL":                   {"internal", false},
	}
	for code, want := range cases {
		category, retryable, _ := errorInfo(code)
		if category != want.category || retryable != want.retryable {
			t.Errorf("%s = (%q, %t), want (%q, %t)", code, category, retryable, want.category, want.retryable)
		}
	}
}

func TestTransitionsApprovalAndTerminalProtection(t *testing.T) {
	service := NewAgentRuntimeService(nil, func(_ TenantContext, binding ApprovalBinding) bool {
		return binding.ApprovalRequestID == "approval_100"
	}, nil)
	context := serviceContext("tenant_a", "actor_a")
	run, _, err := service.CreateRun(context, CreateRunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.TransitionRun(context, run.AgentRunID, "completed", "")
	requireCode(t, "LIFECYCLE_ILLEGAL_TRANSITION", err)
	if _, err = service.TransitionRun(context, run.AgentRunID, "running", ""); err != nil {
		t.Fatal(err)
	}
	_, err = service.PauseForApproval(context, run.AgentRunID, "", "run")
	requireCode(t, "APPROVAL_REQUIRED", err)
	if _, err = service.PauseForApproval(context, run.AgentRunID, "approval_100", "run"); err != nil {
		t.Fatal(err)
	}
	if status, err := service.Resume(context, run.AgentRunID, "run"); err != nil || status != "running" {
		t.Fatalf("resume = %q, %v", status, err)
	}
	if _, err = service.TransitionRun(context, run.AgentRunID, "completed", ""); err != nil {
		t.Fatal(err)
	}
	_, err = service.TransitionRun(context, run.AgentRunID, "running", "")
	requireCode(t, "LIFECYCLE_ILLEGAL_TRANSITION", err)

	revoked := NewAgentRuntimeService(service.Store, nil, func(TenantContext, string) bool { return false })
	another, _, err := service.CreateRun(context, CreateRunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.TransitionRun(context, another.AgentRunID, "running", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.PauseForApproval(context, another.AgentRunID, "approval_100", "run"); err != nil {
		t.Fatal(err)
	}
	_, err = revoked.Resume(context, another.AgentRunID, "run")
	requireCode(t, "TENANT_AUTHORIZATION_REVOKED", err)
}

func TestRetryCancellationAndRecovery(t *testing.T) {
	service := NewAgentRuntimeService(nil, nil, nil)
	context := serviceContext("tenant_a", "actor_a")
	run, _, err := service.CreateRun(context, CreateRunOptions{MaxRetries: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.TransitionRun(context, run.AgentRunID, "running", ""); err != nil {
		t.Fatal(err)
	}
	execution, _, err := service.CreateToolExecution(context, CreateToolOptions{
		AgentRunID: run.AgentRunID, ToolName: "site.publish", ToolVersion: ContractVersion, IdempotencyKey: "retry-request-00001", MaxRetries: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.TransitionTool(context, execution.ToolExecutionID, "running", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = service.WaitForRetry(context, execution.ToolExecutionID, "TOOL_TIMEOUT", 0, "tool"); err != nil {
		t.Fatal(err)
	}
	retried, err := service.Retry(context, execution.ToolExecutionID)
	if err != nil {
		t.Fatal(err)
	}
	if retried.ToolExecutionID == execution.ToolExecutionID || retried.AgentRunID != run.AgentRunID ||
		retried.TenantID != context.TenantID || retried.TraceID != context.TraceID || retried.IdempotencyKey != execution.IdempotencyKey ||
		retried.Attempt != 2 {
		t.Fatalf("invalid retry: %+v", retried)
	}
	if _, err = service.WaitForRetry(context, retried.ToolExecutionID, "TOOL_TIMEOUT", 0, "tool"); err != nil {
		t.Fatal(err)
	}
	if terminal, err := service.Tool(context, retried.ToolExecutionID); err != nil || terminal.Status != "waiting_retry" {
		t.Fatalf("second retry wait = %+v, %v", terminal, err)
	}
	finalAttempt, err := service.Retry(context, retried.ToolExecutionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.WaitForRetry(context, finalAttempt.ToolExecutionID, "TOOL_TIMEOUT", 0, "tool"); err != nil {
		t.Fatal(err)
	}
	if terminal, err := service.Tool(context, finalAttempt.ToolExecutionID); err != nil || terminal.Status != "failed" || terminal.Retry.Retryable {
		t.Fatalf("retry budget must terminally fail: %+v, %v", terminal, err)
	}
	if status, err := service.Cancel(context, run.AgentRunID, "run"); err != nil || status != "cancel_requested" {
		t.Fatalf("cancel = %q, %v", status, err)
	}
	if status, err := service.ConfirmCancellation(context, run.AgentRunID, "run"); err != nil || status != "cancelled" {
		t.Fatalf("confirm cancellation = %q, %v", status, err)
	}
	recoverable, _, err := service.CreateRun(context, CreateRunOptions{MaxRetries: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.TransitionRun(context, recoverable.AgentRunID, "running", ""); err != nil {
		t.Fatal(err)
	}
	recovered, err := service.Recover(context)
	foundRun := false
	for _, id := range recovered {
		foundRun = foundRun || id == recoverable.AgentRunID
	}
	if err != nil || !foundRun {
		t.Fatalf("recover = %#v, %v", recovered, err)
	}
	record, err := service.Run(context, recoverable.AgentRunID)
	if err != nil || record.Status != "failed" {
		t.Fatalf("recovered status = %+v, %v", record, err)
	}
}
