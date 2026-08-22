package agentruntime

import (
	"strings"
	"testing"
	"time"
)

func providerEffect(context TenantContext) ProviderEffectBinding {
	return ProviderEffectBinding{
		ContractVersion: ContractVersion, EffectID: "effect_100", AgentRunID: "run_100",
		ToolExecutionID: "exec_100", Attempt: 1, TenantID: context.TenantID, ActorID: context.ActorID,
		ActorType: context.ActorType, ToolName: "site.publish", ToolVersion: ContractVersion,
		IdempotencyKey: "provider-request-001", CanonicalRequestHash: strings.Repeat("a", 64),
		ApprovalRequestID: "approval_100", ApprovalInputHash: strings.Repeat("a", 64),
		TraceID: context.TraceID, AuditID: "audit_100", CorrelationID: "correlation_100",
		ReconcileBy: time.Now().UTC().Add(time.Minute),
	}
}

func TestProviderEffectBindingRejectsHashTenantAndApprovalConflicts(t *testing.T) {
	context := serviceContext("tenant_a", "actor_a")
	effect := providerEffect(context)
	if err := effect.ValidateForContext(context); err != nil {
		t.Fatal(err)
	}

	changedHash := effect
	changedHash.CanonicalRequestHash = strings.Repeat("b", 64)
	changedHash.ApprovalInputHash = strings.Repeat("a", 64)
	requireCode(t, "PROVIDER_EFFECT_APPROVAL_MISMATCH", changedHash.ValidateForContext(context))

	crossTenant := effect
	crossTenant.TenantID = "tenant_b"
	requireCode(t, "PROVIDER_EFFECT_BINDING_INVALID", crossTenant.ValidateForContext(context))

	missingApproval := effect
	missingApproval.ApprovalInputHash = ""
	requireCode(t, "PROVIDER_EFFECT_APPROVAL_MISMATCH", missingApproval.ValidateForContext(context))
}

func TestProviderEffectReconciliationFailsClosedForUnknownEffects(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		state    ProviderEffectState
		canRetry bool
	}{
		{ProviderEffectSafeToRetry, true},
		{ProviderEffectCompleted, false},
		{ProviderEffectFailed, false},
		{ProviderEffectUnknown, false},
	}
	for _, test := range cases {
		result := ProviderEffectReconciliation{State: test.state, ObservedAt: now}
		if err := result.Validate(); err != nil {
			t.Fatalf("%s invalid: %v", test.state, err)
		}
		if result.CanAutoRetry() != test.canRetry {
			t.Fatalf("%s retry = %t, want %t", test.state, result.CanAutoRetry(), test.canRetry)
		}
	}
	retryAt := now.Add(time.Minute)
	requireCode(t, "PROVIDER_EFFECT_RECONCILIATION_INVALID", ProviderEffectReconciliation{
		State: ProviderEffectUnknown, ObservedAt: now, RetryAfter: &retryAt,
	}.Validate())
}
