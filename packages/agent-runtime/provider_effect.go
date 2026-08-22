package agentruntime

import (
	"regexp"
	"time"
)

var requestHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ProviderEffectState is the reconciliation result for one immutable provider
// request. Unknown is deliberately not retryable: the provider may have acted.
type ProviderEffectState string

const (
	ProviderEffectSafeToRetry ProviderEffectState = "safe_to_retry"
	ProviderEffectCompleted   ProviderEffectState = "completed"
	ProviderEffectFailed      ProviderEffectState = "failed"
	ProviderEffectUnknown     ProviderEffectState = "unknown_in_flight"
)

type ProviderEffectBinding struct {
	ContractVersion      string
	EffectID             string
	AgentRunID           string
	ToolExecutionID      string
	Attempt              int
	TenantID             string
	ActorID              string
	ActorType            string
	ToolName             string
	ToolVersion          string
	IdempotencyKey       string
	CanonicalRequestHash string
	ApprovalRequestID    string
	ApprovalInputHash    string
	TraceID              string
	AuditID              string
	CorrelationID        string
	ReconcileBy          time.Time
}

type ProviderEffectClaim struct {
	Existing             bool
	EffectID             string
	CanonicalRequestHash string
}

type ProviderEffectReconciliation struct {
	State             ProviderEffectState
	ProviderReference string
	ObservedAt        time.Time
	RetryAfter        *time.Time
	FailureCode       string
}

func (result ProviderEffectReconciliation) CanAutoRetry() bool {
	return result.State == ProviderEffectSafeToRetry
}

// ValidateForContext prevents a durable provider request from being replayed
// with a different tenant, actor, trace, approval, or canonical request.
func (effect ProviderEffectBinding) ValidateForContext(context TenantContext) error {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return err
	}
	if effect.ContractVersion != ContractVersion ||
		!nameID.MatchString(effect.EffectID) ||
		!nameID.MatchString(effect.AgentRunID) ||
		!nameID.MatchString(effect.ToolExecutionID) ||
		effect.Attempt < 1 ||
		effect.TenantID != context.TenantID ||
		effect.ActorID != context.ActorID ||
		effect.ActorType != context.ActorType ||
		effect.TraceID != context.TraceID ||
		!nameID.MatchString(effect.ToolName) ||
		!version.MatchString(effect.ToolVersion) ||
		!nameID.MatchString(effect.IdempotencyKey) ||
		!requestHash.MatchString(effect.CanonicalRequestHash) ||
		!nameID.MatchString(effect.AuditID) ||
		!nameID.MatchString(effect.CorrelationID) ||
		effect.ReconcileBy.IsZero() {
		return runtimeError("PROVIDER_EFFECT_BINDING_INVALID", "Provider effect binding is invalid.")
	}
	if (effect.ApprovalRequestID == "") != (effect.ApprovalInputHash == "") ||
		(effect.ApprovalRequestID != "" && (!nameID.MatchString(effect.ApprovalRequestID) || effect.ApprovalInputHash != effect.CanonicalRequestHash)) {
		return runtimeError("PROVIDER_EFFECT_APPROVAL_MISMATCH", "Provider effect approval binding is invalid.")
	}
	return nil
}

func (result ProviderEffectReconciliation) Validate() error {
	switch result.State {
	case ProviderEffectSafeToRetry, ProviderEffectCompleted, ProviderEffectFailed, ProviderEffectUnknown:
	default:
		return runtimeError("PROVIDER_EFFECT_RECONCILIATION_INVALID", "Provider effect reconciliation state is invalid.")
	}
	if result.ObservedAt.IsZero() {
		return runtimeError("PROVIDER_EFFECT_RECONCILIATION_INVALID", "Provider effect reconciliation timestamp is required.")
	}
	if result.State == ProviderEffectUnknown && result.RetryAfter != nil {
		return runtimeError("PROVIDER_EFFECT_RECONCILIATION_INVALID", "Unknown provider effects require manual recovery.")
	}
	return nil
}
