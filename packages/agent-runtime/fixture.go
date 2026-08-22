package agentruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

// Product is canonical commerce data supplied to the deterministic fixture.
type Product struct {
	TenantID   string `json:"tenant_id"`
	ProductID  string `json:"product_id"`
	Name       string `json:"name"`
	PriceMinor int    `json:"price_minor"`
}

type FixtureApprovalRequest struct {
	ApprovalID     string
	Context        TenantContext
	Input          map[string]any
	IdempotencyKey string
}

type ProductProvider func(Product) (Product, error)
type FixtureApprover func(FixtureApprovalRequest) bool

type AgentRuntimeFixture struct {
	Service       *AgentRuntimeService
	products      []Product
	approve       FixtureApprover
	productSource ProductProvider
	mu            sync.Mutex
	requests      map[string]fixtureRequest
	lastExecution map[string]string
	pending       map[string]fixtureApproval
}

type fixtureRequest struct {
	Hash     string
	Response ToolResponse
}

type fixtureApproval struct {
	TenantID       string
	ActorID        string
	TraceID        string
	ToolName       string
	InputHash      string
	IdempotencyKey string
}

type FixtureStart struct {
	Context TenantContext
	Run     AgentRun
}

type FixtureLookupResult struct {
	Run      AgentRun
	Response ToolResponse
}

type ExecuteToolRequest struct {
	Context        TenantContext
	RunID          string
	ToolName       string
	Input          map[string]any
	IdempotencyKey string
	HighRisk       bool
	ApprovalID     string
	Attempt        int
}

func NewAgentRuntimeFixture(products []Product, approve FixtureApprover, provider ProductProvider) *AgentRuntimeFixture {
	fixture := &AgentRuntimeFixture{
		products: products, approve: approve, productSource: provider,
		requests: map[string]fixtureRequest{}, lastExecution: map[string]string{}, pending: map[string]fixtureApproval{},
	}
	if fixture.approve == nil {
		fixture.approve = func(FixtureApprovalRequest) bool { return false }
	}
	if fixture.productSource == nil {
		fixture.productSource = func(product Product) (Product, error) { return product, nil }
	}
	fixture.Service = NewAgentRuntimeService(nil, func(context TenantContext, binding ApprovalBinding) bool {
		return fixture.approve(FixtureApprovalRequest{
			ApprovalID: binding.ApprovalRequestID, Context: context, IdempotencyKey: binding.IdempotencyKey,
		})
	}, nil)
	return fixture
}

func (fixture *AgentRuntimeFixture) StartRun(context TenantContext) (FixtureStart, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return FixtureStart{}, err
	}
	run, _, err := fixture.Service.CreateRun(context, CreateRunOptions{AgentType: "customer", MaxRetries: 2})
	if err != nil {
		return FixtureStart{}, err
	}
	run, err = fixture.Service.TransitionRun(context, run.AgentRunID, "running", "")
	return FixtureStart{Context: context, Run: run}, err
}

func (fixture *AgentRuntimeFixture) LookupProduct(context TenantContext, productID, idempotencyKey string) (FixtureLookupResult, error) {
	started, err := fixture.StartRun(context)
	if err != nil {
		return FixtureLookupResult{}, err
	}
	response, err := fixture.ExecuteTool(ExecuteToolRequest{
		Context: started.Context, RunID: started.Run.AgentRunID, ToolName: "product.lookup",
		Input: map[string]any{"product_id": productID}, IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		return FixtureLookupResult{}, err
	}
	run, err := fixture.Service.Run(started.Context, started.Run.AgentRunID)
	return FixtureLookupResult{Run: run, Response: response}, err
}

func (fixture *AgentRuntimeFixture) ExecuteTool(request ExecuteToolRequest) (ToolResponse, error) {
	context, err := ValidateTenantContext(request.Context)
	if err != nil {
		return ToolResponse{}, err
	}
	run, err := fixture.Service.Run(context, request.RunID)
	if err != nil {
		return ToolResponse{}, err
	}
	if len(request.IdempotencyKey) < 16 || !nameID.MatchString(request.IdempotencyKey) || !nameID.MatchString(request.ToolName) ||
		request.Input == nil || !validToolInput(request.Input) {
		return fixture.failure(context, request.ToolName, request.IdempotencyKey, "TOOL_INVALID_REQUEST"), nil
	}
	hash := fixtureRequestHash(context, request.ToolName, request.Input)
	scope := fmtScope(context.TenantID, request.ToolName, ContractVersion, request.IdempotencyKey)
	fixture.mu.Lock()
	previous, hasPrevious := fixture.requests[scope]
	fixture.mu.Unlock()
	if hasPrevious && !previous.Response.Retryable {
		if previous.Hash != hash {
			return fixture.failure(context, request.ToolName, request.IdempotencyKey, "TOOL_CONFLICT"), nil
		}
		return previous.Response, nil
	}
	if !hasScope(context, "product:read") {
		response := fixture.failure(context, request.ToolName, request.IdempotencyKey, "TOOL_FORBIDDEN")
		fixture.remember(scope, hash, response)
		return response, nil
	}
	execution, duplicate, err := fixture.Service.CreateToolExecution(context, CreateToolOptions{
		AgentRunID: run.AgentRunID, ToolName: request.ToolName, ToolVersion: ContractVersion,
		IdempotencyKey: request.IdempotencyKey, MaxRetries: 2,
	})
	if err != nil {
		return ToolResponse{}, err
	}
	if duplicate {
		execution, err = fixture.Service.Tool(context, execution.ToolExecutionID)
		if err != nil {
			return ToolResponse{}, err
		}
	}
	if request.HighRisk && request.ApprovalID == "" {
		approvalID := generatedID("approval")
		if execution.Status == "queued" {
			execution, err = fixture.Service.TransitionTool(context, execution.ToolExecutionID, "running", "")
			if err != nil {
				return ToolResponse{}, err
			}
		}
		if execution.Status == "running" {
			if _, err := fixture.Service.PauseForApproval(context, execution.ToolExecutionID, approvalID, "tool"); err != nil {
				return ToolResponse{}, err
			}
		}
		if run.Status == "running" {
			if _, err := fixture.Service.PauseForApproval(context, run.AgentRunID, approvalID, "run"); err != nil {
				return ToolResponse{}, err
			}
		}
		fixture.mu.Lock()
		fixture.pending[approvalID] = fixtureApproval{
			TenantID: context.TenantID, ActorID: context.ActorID, TraceID: context.TraceID,
			ToolName: request.ToolName, InputHash: hash, IdempotencyKey: request.IdempotencyKey,
		}
		fixture.mu.Unlock()
		return toolFailure("TOOL_APPROVAL_REQUIRED", context.TraceID, execution.AuditID, execution.ToolExecutionID, request.IdempotencyKey), nil
	}
	if request.HighRisk {
		fixture.mu.Lock()
		pending, found := fixture.pending[request.ApprovalID]
		fixture.mu.Unlock()
		if !found || pending.TenantID != context.TenantID || pending.ActorID != context.ActorID ||
			pending.TraceID != context.TraceID || pending.ToolName != request.ToolName ||
			pending.InputHash != hash || pending.IdempotencyKey != request.IdempotencyKey ||
			!fixture.approve(FixtureApprovalRequest{
				ApprovalID: request.ApprovalID, Context: context, Input: request.Input, IdempotencyKey: request.IdempotencyKey,
			}) {
			return fixture.failure(context, request.ToolName, request.IdempotencyKey, "TOOL_APPROVAL_EXPIRED"), nil
		}
		fixture.mu.Lock()
		delete(fixture.pending, request.ApprovalID)
		fixture.mu.Unlock()
	}
	if execution.Status == "waiting_approval" {
		if _, err := fixture.Service.TransitionTool(context, execution.ToolExecutionID, "running", ""); err != nil {
			return ToolResponse{}, err
		}
	}
	run, err = fixture.Service.Run(context, run.AgentRunID)
	if err != nil {
		return ToolResponse{}, err
	}
	if run.Status == "waiting_approval" {
		if _, err := fixture.Service.TransitionRun(context, run.AgentRunID, "running", ""); err != nil {
			return ToolResponse{}, err
		}
	}
	if execution.Status == "queued" {
		execution, err = fixture.Service.TransitionTool(context, execution.ToolExecutionID, "running", "")
		if err != nil {
			return ToolResponse{}, err
		}
	}
	return fixture.perform(context, run.AgentRunID, execution, request.Input, hash, scope)
}

func (fixture *AgentRuntimeFixture) ResumeRetry(context TenantContext, runID, productID, idempotencyKey string) (FixtureLookupResult, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return FixtureLookupResult{}, err
	}
	run, err := fixture.Service.Run(context, runID)
	if err != nil {
		return FixtureLookupResult{}, err
	}
	if run.Status != "waiting_retry" {
		return fixture.LookupProduct(context, productID, idempotencyKey)
	}
	fixture.mu.Lock()
	previousID := fixture.lastExecution[runID]
	fixture.mu.Unlock()
	execution, err := fixture.Service.Retry(context, previousID)
	if err != nil {
		return FixtureLookupResult{}, err
	}
	if _, err := fixture.Service.Resume(context, runID, "run"); err != nil {
		return FixtureLookupResult{}, err
	}
	hash := fixtureRequestHash(context, "product.lookup", map[string]any{"product_id": productID})
	scope := fmtScope(context.TenantID, "product.lookup", ContractVersion, idempotencyKey)
	response, err := fixture.perform(context, runID, execution, map[string]any{"product_id": productID}, hash, scope)
	if err != nil {
		return FixtureLookupResult{}, err
	}
	run, err = fixture.Service.Run(context, runID)
	return FixtureLookupResult{Run: run, Response: response}, err
}

func (fixture *AgentRuntimeFixture) Execution(context TenantContext, id string) (ToolExecution, error) {
	return fixture.Service.Tool(context, id)
}

func (fixture *AgentRuntimeFixture) perform(context TenantContext, runID string, execution ToolExecution, input map[string]any, hash, scope string) (ToolResponse, error) {
	code := ""
	productID, validProductID := input["product_id"].(string)
	if len(input) != 1 || !validProductID || productID == "" || execution.ToolName != "product.lookup" {
		code = "TOOL_INVALID_REQUEST"
	} else {
		var product Product
		found := false
		for _, candidate := range fixture.products {
			if candidate.TenantID == context.TenantID && candidate.ProductID == productID {
				product, found = candidate, true
				break
			}
		}
		if !found {
			code = "TOOL_NOT_FOUND"
		} else {
			canonicalProduct, providerErr := fixture.productSource(product)
			if providerErr != nil || canonicalProduct.TenantID != context.TenantID || canonicalProduct.ProductID != product.ProductID {
				code = "TOOL_PROVIDER_FAILED"
			} else {
				execution, err := fixture.Service.TransitionTool(context, execution.ToolExecutionID, "succeeded", "")
				if err != nil {
					return ToolResponse{}, err
				}
				if _, err := fixture.Service.TransitionRun(context, runID, "completed", ""); err != nil {
					return ToolResponse{}, err
				}
				response := productSuccess(canonicalProduct, context.TraceID, execution.AuditID, execution.ToolExecutionID, execution.IdempotencyKey)
				fixture.remember(scope, hash, response)
				return response, nil
			}
		}
	}
	if code == "TOOL_PROVIDER_FAILED" {
		if _, err := fixture.Service.WaitForRetry(context, execution.ToolExecutionID, code, 0, "tool"); err != nil {
			return ToolResponse{}, err
		}
		if _, err := fixture.Service.WaitForRetry(context, runID, code, 0, "run"); err != nil {
			return ToolResponse{}, err
		}
	} else {
		if _, err := fixture.Service.TransitionTool(context, execution.ToolExecutionID, "failed", ""); err != nil {
			return ToolResponse{}, err
		}
		if _, err := fixture.Service.TransitionRun(context, runID, "failed", ""); err != nil {
			return ToolResponse{}, err
		}
	}
	response := toolFailure(code, context.TraceID, execution.AuditID, execution.ToolExecutionID, execution.IdempotencyKey)
	if !response.Retryable {
		fixture.remember(scope, hash, response)
	}
	fixture.mu.Lock()
	fixture.lastExecution[runID] = execution.ToolExecutionID
	fixture.mu.Unlock()
	return response, nil
}

func (fixture *AgentRuntimeFixture) failure(context TenantContext, toolName, idempotencyKey, code string) ToolResponse {
	auditID, err := fixture.Service.RecordAudit(context, "tool.reject", "tool_execution", "", "rejected")
	if err != nil {
		panic(err)
	}
	return toolFailure(code, context.TraceID, auditID, "", idempotencyKey)
}

func (fixture *AgentRuntimeFixture) remember(scope, hash string, response ToolResponse) {
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	fixture.requests[scope] = fixtureRequest{Hash: hash, Response: response}
}

func fixtureRequestHash(context TenantContext, toolName string, input map[string]any) string {
	value := map[string]any{
		"context": map[string]any{
			"schema_version": context.SchemaVersion, "tenant_id": context.TenantID, "actor_id": context.ActorID,
			"actor_type": context.ActorType, "roles": stringSliceAny(context.Roles), "scopes": stringSliceAny(context.Scopes),
			"trace_id": context.TraceID, "request_origin": map[string]any{"kind": context.RequestOrigin.Kind, "request_id": context.RequestOrigin.RequestID},
		},
		"tool_name": toolName, "input": input,
	}
	sum := sha256.Sum256([]byte(canonical(value)))
	return hex.EncodeToString(sum[:])
}

func stringSliceAny(values []string) []any {
	result := make([]any, len(values))
	for index := range values {
		result[index] = values[index]
	}
	return result
}
