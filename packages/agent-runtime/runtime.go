// Package agentruntime implements the server-side Agent Runtime v1 contracts.
package agentruntime

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const ContractVersion = "1.0"

var (
	opaqueID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$`)
	nameID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$`)
	traceID  = regexp.MustCompile(`^[0-9a-f]{32}$`)
	version  = regexp.MustCompile(`^[0-9]+\.[0-9]+$`)
)

type RuntimeError struct {
	Code    string
	Message string
}

func (e *RuntimeError) Error() string { return e.Code + ": " + e.Message }

func runtimeError(code, message string) error { return &RuntimeError{Code: code, Message: message} }

func ErrorCode(err error) string {
	var runtimeErr *RuntimeError
	if errors.As(err, &runtimeErr) {
		return runtimeErr.Code
	}
	return ""
}

type RequestOrigin struct {
	Kind      string `json:"kind"`
	RequestID string `json:"request_id"`
}

type TenantContext struct {
	SchemaVersion string        `json:"schema_version"`
	TenantID      string        `json:"tenant_id"`
	ActorID       string        `json:"actor_id"`
	ActorType     string        `json:"actor_type"`
	Roles         []string      `json:"roles"`
	Scopes        []string      `json:"scopes"`
	TraceID       string        `json:"trace_id"`
	RequestOrigin RequestOrigin `json:"request_origin"`
	SiteID        string        `json:"site_id,omitempty"`
	ProjectID     string        `json:"project_id,omitempty"`
}

var validRoles = map[string]bool{
	"tenant_owner": true, "tenant_admin": true, "merchant_operator": true,
	"support_readonly": true, "customer": true, "system_service": true,
}
var validScopes = map[string]bool{
	"tenant:read": true, "tenant:write": true, "site:read": true, "site:write": true,
	"site:publish": true, "product:read": true, "product:write": true,
	"asset:read": true, "asset:write": true, "knowledge:read": true,
	"knowledge:write": true, "domain:read": true, "domain:purchase": true,
	"domain:write": true, "commerce:read": true, "commerce:write": true,
	"lead:read": true, "lead:write": true, "agent:run": true, "ops:read": true,
	"ops:retry": true,
}
var userOrigins = map[string]bool{"merchant_console": true, "customer_site": true, "public_api": true}
var serviceOrigins = map[string]bool{"webhook": true, "scheduled_job": true, "internal_worker": true}

func ParseTenantContext(data []byte) (TenantContext, error) {
	var context TenantContext
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&context); err != nil {
		return TenantContext{}, runtimeError("TENANT_CONTEXT_INVALID", "A valid TenantContext v1 is required.")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return TenantContext{}, runtimeError("TENANT_CONTEXT_INVALID", "A valid TenantContext v1 is required.")
	}
	return ValidateTenantContext(context)
}

func ValidateTenantContext(context TenantContext) (TenantContext, error) {
	if context.SchemaVersion != ContractVersion || !opaqueID.MatchString(context.TenantID) ||
		!opaqueID.MatchString(context.ActorID) || !traceID.MatchString(context.TraceID) ||
		context.TraceID == strings.Repeat("0", 32) || !opaqueID.MatchString(context.RequestOrigin.RequestID) ||
		(len(context.Roles) == 0 || len(context.Roles) > 8) ||
		(len(context.Scopes) == 0 || len(context.Scopes) > 32) ||
		(context.SiteID != "" && !opaqueID.MatchString(context.SiteID)) ||
		(context.ProjectID != "" && !opaqueID.MatchString(context.ProjectID)) {
		return TenantContext{}, runtimeError("TENANT_CONTEXT_INVALID", "A valid TenantContext v1 is required.")
	}
	if !validContextValues(context) {
		return TenantContext{}, runtimeError("TENANT_CONTEXT_INVALID", "A valid TenantContext v1 is required.")
	}
	context.Roles = append([]string(nil), context.Roles...)
	context.Scopes = append([]string(nil), context.Scopes...)
	return context, nil
}

func validContextValues(context TenantContext) bool {
	seen := map[string]bool{}
	for _, role := range context.Roles {
		if !validRoles[role] || seen[role] {
			return false
		}
		seen[role] = true
	}
	seen = map[string]bool{}
	for _, scope := range context.Scopes {
		if !validScopes[scope] || seen[scope] {
			return false
		}
		seen[scope] = true
	}
	switch context.ActorType {
	case "user":
		return userOrigins[context.RequestOrigin.Kind] && !seenRole(context.Roles, "system_service")
	case "customer_session":
		return context.RequestOrigin.Kind == "customer_site" && len(context.Roles) == 1 && context.Roles[0] == "customer"
	case "service_principal":
		return serviceOrigins[context.RequestOrigin.Kind] && len(context.Roles) == 1 && context.Roles[0] == "system_service"
	default:
		return false
	}
}

func seenRole(roles []string, role string) bool {
	for _, value := range roles {
		if value == role {
			return true
		}
	}
	return false
}

type Retry struct {
	Retryable     bool       `json:"retryable"`
	RetryCount    int        `json:"retry_count"`
	MaxRetries    int        `json:"max_retries"`
	NextRetryAt   *time.Time `json:"next_retry_at,omitempty"`
	BackoffMS     *int       `json:"backoff_ms,omitempty"`
	LastErrorCode *string    `json:"last_error_code,omitempty"`
}

type Accounting struct {
	Model        *string `json:"model,omitempty"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	TotalTokens  int     `json:"total_tokens"`
	CostMinor    int     `json:"cost_minor"`
	Currency     string  `json:"currency"`
	LatencyMS    int     `json:"latency_ms"`
}

type Failure struct {
	Category  string `json:"category"`
	Code      string `json:"code"`
	Retryable bool   `json:"retryable"`
	Message   string `json:"message"`
}

type AgentRun struct {
	ContractVersion    string     `json:"contract_version"`
	AgentRunID         string     `json:"agent_run_id"`
	TenantID           string     `json:"tenant_id"`
	ActorID            string     `json:"actor_id"`
	TraceID            string     `json:"trace_id"`
	WorkflowInstanceID string     `json:"workflow_instance_id,omitempty"`
	AgentType          string     `json:"agent_type"`
	Status             string     `json:"status"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
	StartedAt          *time.Time `json:"started_at"`
	EndedAt            *time.Time `json:"ended_at"`
	ApprovalRequestID  string     `json:"approval_request_id,omitempty"`
	Attempt            int        `json:"attempt"`
	Retry              Retry      `json:"retry"`
	Accounting         Accounting `json:"accounting"`
	Failure            *Failure   `json:"failure"`
	AuditID            string     `json:"audit_id"`
}

type ToolExecution struct {
	ContractVersion    string     `json:"contract_version"`
	ToolExecutionID    string     `json:"tool_execution_id"`
	AgentRunID         string     `json:"agent_run_id"`
	WorkflowInstanceID string     `json:"workflow_instance_id,omitempty"`
	TenantID           string     `json:"tenant_id"`
	ActorID            string     `json:"actor_id"`
	TraceID            string     `json:"trace_id"`
	ToolName           string     `json:"tool_name"`
	ToolVersion        string     `json:"tool_version"`
	IdempotencyKey     string     `json:"idempotency_key"`
	Status             string     `json:"status"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
	StartedAt          *time.Time `json:"started_at"`
	EndedAt            *time.Time `json:"ended_at"`
	ApprovalRequestID  string     `json:"approval_request_id,omitempty"`
	Attempt            int        `json:"attempt"`
	Retry              Retry      `json:"retry"`
	Accounting         Accounting `json:"accounting"`
	Failure            *Failure   `json:"failure"`
	AuditID            string     `json:"audit_id"`
}

type AuditRecord struct {
	AuditID         string    `json:"audit_id"`
	ContractVersion string    `json:"contract_version"`
	TenantID        string    `json:"tenant_id"`
	ActorID         string    `json:"actor_id"`
	ActorType       string    `json:"actor_type"`
	TraceID         string    `json:"trace_id"`
	OriginKind      string    `json:"origin_kind"`
	Action          string    `json:"action"`
	TargetType      string    `json:"target_type"`
	TargetID        string    `json:"target_id"`
	Outcome         string    `json:"outcome"`
	CreatedAt       time.Time `json:"created_at"`
}

type InMemoryRuntimeStore struct {
	mu          sync.RWMutex
	runs        map[string]AgentRun
	tools       map[string]ToolExecution
	idempotency map[string]idempotencyClaim
	approvals   map[string]ApprovalBinding
	audit       []AuditRecord
}

type idempotencyClaim struct {
	TargetID    string
	RequestHash string
}

// ProductionRuntimeStore is the minimum persistence boundary for durable workers.
// A production adapter must atomically claim a request and reconcile uncertain
// in-flight provider effects before allowing a restart to resume execution.
type ProductionRuntimeStore interface {
	ClaimIdempotency(scope, requestHash, targetID string) (existingID string, conflict bool, err error)
	ClaimRecoverableWork(tenantID string, limit int) ([]string, error)
	ReconcileInFlightEffect(tenantID, toolExecutionID, idempotencyKey string) (known bool, err error)
}

func NewInMemoryRuntimeStore() *InMemoryRuntimeStore {
	return &InMemoryRuntimeStore{
		runs: map[string]AgentRun{}, tools: map[string]ToolExecution{},
		idempotency: map[string]idempotencyClaim{}, approvals: map[string]ApprovalBinding{},
	}
}

func (store *InMemoryRuntimeStore) Run(id string) (AgentRun, bool) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	record, ok := store.runs[id]
	return record, ok
}

func (store *InMemoryRuntimeStore) Tool(id string) (ToolExecution, bool) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	record, ok := store.tools[id]
	return record, ok
}

func (store *InMemoryRuntimeStore) AuditRecords() []AuditRecord {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return append([]AuditRecord(nil), store.audit...)
}

func (store *InMemoryRuntimeStore) withLock(operation func()) {
	store.mu.Lock()
	defer store.mu.Unlock()
	operation()
}

func defaultRetry(max int) Retry {
	if max < 0 {
		max = 0
	}
	return Retry{MaxRetries: max}
}

func defaultAccounting() Accounting { return Accounting{Currency: "USD"} }

func generatedID(prefix string) string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic("secure identifier generation failed")
	}
	return prefix + "_" + hex.EncodeToString(bytes)
}

func canonical(value any) string {
	switch value := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			encoded, _ := json.Marshal(key)
			parts = append(parts, string(encoded)+":"+canonical(value[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := make([]string, len(value))
		for index := range value {
			parts[index] = canonical(value[index])
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
}

func hasScope(context TenantContext, scope string) bool {
	for _, value := range context.Scopes {
		if value == scope {
			return true
		}
	}
	return false
}

func ownership(context TenantContext, tenant, actor, trace string) bool {
	return context.TenantID == tenant && context.ActorID == actor && context.TraceID == trace
}

func validToolInput(input map[string]any) bool {
	for _, field := range []string{"schema_version", "tenant_id", "actor_id", "actor_type", "roles", "scopes", "trace_id", "request_origin"} {
		if _, present := input[field]; present {
			return false
		}
	}
	return true
}

func toolFailure(code, trace, audit, execution, key string) ToolResponse {
	category, retryable, message := errorInfo(code)
	return ToolResponse{
		EnvelopeType: "tool_response", ContractVersion: ContractVersion, Success: false,
		Data: nil, Error: &ToolError{Code: code, Category: category, Message: message},
		Retryable: retryable, TraceID: trace, AuditID: audit, ToolExecutionID: execution, IdempotencyKey: key,
	}
}

func errorInfo(code string) (string, bool, string) {
	switch code {
	case "TOOL_INVALID_REQUEST":
		return "validation", false, "The request is invalid."
	case "TOOL_UNSUPPORTED_VERSION":
		return "validation", false, "The requested contract version is unsupported."
	case "TOOL_FORBIDDEN":
		return "authorization", false, "The request is not authorized."
	case "TOOL_APPROVAL_REQUIRED":
		return "approval", false, "Approval is required before this action can run."
	case "TOOL_APPROVAL_EXPIRED":
		return "approval", false, "The approval is no longer valid."
	case "TOOL_CONFLICT":
		return "conflict", false, "The request conflicts with an earlier request."
	case "TOOL_NOT_FOUND":
		return "not_found", false, "The requested product is not available."
	case "TOOL_RATE_LIMITED":
		return "rate_limit", true, "The request is temporarily rate limited."
	case "TOOL_PROVIDER_FAILED":
		return "provider", true, "The product service is temporarily unavailable."
	case "TOOL_TIMEOUT":
		return "timeout", true, "The tool execution timed out."
	case "TOOL_INFRASTRUCTURE_UNAVAILABLE":
		return "transient_infrastructure", true, "The required infrastructure is temporarily unavailable."
	case "TOOL_INTERNAL":
		return "internal", false, "The request could not be completed."
	default:
		return "internal", false, "The request could not be completed."
	}
}

type ToolError struct {
	Code     string `json:"code"`
	Category string `json:"category"`
	Message  string `json:"message"`
}

type ToolResponse struct {
	EnvelopeType    string     `json:"envelope_type"`
	ContractVersion string     `json:"contract_version"`
	Success         bool       `json:"success"`
	Data            any        `json:"data"`
	Error           *ToolError `json:"error"`
	Retryable       bool       `json:"retryable"`
	TraceID         string     `json:"trace_id"`
	AuditID         string     `json:"audit_id"`
	ToolExecutionID string     `json:"tool_execution_id,omitempty"`
	IdempotencyKey  string     `json:"idempotency_key"`
}

func productSuccess(product Product, trace, audit, execution, key string) ToolResponse {
	return ToolResponse{
		EnvelopeType: "tool_response", ContractVersion: ContractVersion, Success: true,
		Data: map[string]any{"product": product}, Error: nil, Retryable: false,
		TraceID: trace, AuditID: audit, ToolExecutionID: execution, IdempotencyKey: key,
	}
}

func ensureID(value string) error {
	if !nameID.MatchString(value) {
		return runtimeError("RUNTIME_VALIDATION", "Identifier is invalid.")
	}
	return nil
}

func mustTime() time.Time { return time.Now().UTC() }

func fmtScope(tenant, name, toolVersion, key string) string {
	return fmt.Sprintf("%s:%s:%s:%s", tenant, name, toolVersion, key)
}
