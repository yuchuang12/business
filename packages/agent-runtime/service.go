package agentruntime

type ApprovalBinding struct {
	ApprovalRequestID string
	ToolName          string
	ToolVersion       string
	IdempotencyKey    string
}

type ApprovalValidator func(TenantContext, ApprovalBinding) bool
type AuthorizationValidator func(TenantContext, string) bool

type AgentRuntimeService struct {
	Store                  *InMemoryRuntimeStore
	ApprovalValidator      ApprovalValidator
	AuthorizationValidator AuthorizationValidator
}

type CreateRunOptions struct {
	AgentType          string
	WorkflowInstanceID string
	MaxRetries         int
	MaxRetriesSet      bool
	IdempotencyKey     string
}

type CreateToolOptions struct {
	AgentRunID     string
	ToolName       string
	ToolVersion    string
	IdempotencyKey string
	MaxRetries     int
	MaxRetriesSet  bool
}

func NewAgentRuntimeService(store *InMemoryRuntimeStore, approval ApprovalValidator, authorization AuthorizationValidator) *AgentRuntimeService {
	if store == nil {
		store = NewInMemoryRuntimeStore()
	}
	if approval == nil {
		approval = func(TenantContext, ApprovalBinding) bool { return true }
	}
	if authorization == nil {
		authorization = func(TenantContext, string) bool { return true }
	}
	return &AgentRuntimeService{Store: store, ApprovalValidator: approval, AuthorizationValidator: authorization}
}

func (service *AgentRuntimeService) CreateRun(context TenantContext, options CreateRunOptions) (AgentRun, bool, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return AgentRun{}, false, err
	}
	if options.AgentType == "" {
		options.AgentType = "merchant"
	}
	if options.MaxRetries == 0 && !options.MaxRetriesSet {
		options.MaxRetries = 3
	}
	if options.AgentType != "merchant" && options.AgentType != "customer" && options.AgentType != "system" {
		return AgentRun{}, false, runtimeError("RUNTIME_VALIDATION", "Invalid agent type.")
	}
	if options.WorkflowInstanceID != "" {
		if err := ensureID(options.WorkflowInstanceID); err != nil {
			return AgentRun{}, false, err
		}
	}
	var result AgentRun
	duplicate := false
	service.Store.withLock(func() {
		scope := ""
		if options.IdempotencyKey != "" {
			scope = context.TenantID + ":agent-run:" + options.IdempotencyKey
			if existingID := service.Store.idempotency[scope]; existingID != "" {
				result = service.Store.runs[existingID]
				duplicate = true
				return
			}
		}
		now := mustTime()
		result = AgentRun{
			ContractVersion: ContractVersion, AgentRunID: generatedID("run"), TenantID: context.TenantID,
			ActorID: context.ActorID, TraceID: context.TraceID, WorkflowInstanceID: options.WorkflowInstanceID,
			AgentType: options.AgentType, Status: "queued", CreatedAt: now, UpdatedAt: now, Attempt: 1,
			Retry: defaultRetry(options.MaxRetries), Accounting: defaultAccounting(), AuditID: generatedID("audit"),
		}
		service.Store.runs[result.AgentRunID] = result
		if scope != "" {
			service.Store.idempotency[scope] = result.AgentRunID
		}
		service.auditLocked(context, "run.create", "agent_run", result.AgentRunID, "accepted")
	})
	return result, duplicate, nil
}

func (service *AgentRuntimeService) CreateToolExecution(context TenantContext, options CreateToolOptions) (ToolExecution, bool, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return ToolExecution{}, false, err
	}
	if options.ToolVersion == "" {
		options.ToolVersion = ContractVersion
	}
	if options.MaxRetries == 0 && !options.MaxRetriesSet {
		options.MaxRetries = 3
	}
	if !nameID.MatchString(options.ToolName) || !version.MatchString(options.ToolVersion) || len(options.IdempotencyKey) < 16 || !nameID.MatchString(options.IdempotencyKey) {
		return ToolExecution{}, false, runtimeError("RUNTIME_VALIDATION", "Tool name and idempotency key are required.")
	}
	var result ToolExecution
	duplicate := false
	var operationErr error
	service.Store.withLock(func() {
		run, ok := service.Store.runs[options.AgentRunID]
		if !ok || !ownership(context, run.TenantID, run.ActorID, run.TraceID) {
			operationErr = runtimeError("RUNTIME_NOT_FOUND", "AgentRun is not visible in this tenant.")
			return
		}
		if runTerminal(run.Status) {
			operationErr = runtimeError("RUNTIME_CONFLICT", "Cannot add work to a terminal AgentRun.")
			return
		}
		scope := fmtScope(context.TenantID, options.ToolName, options.ToolVersion, options.IdempotencyKey)
		if existingID := service.Store.idempotency[scope]; existingID != "" {
			result = service.Store.tools[existingID]
			duplicate = true
			return
		}
		now := mustTime()
		result = ToolExecution{
			ContractVersion: ContractVersion, ToolExecutionID: generatedID("exec"), AgentRunID: run.AgentRunID,
			WorkflowInstanceID: run.WorkflowInstanceID, TenantID: context.TenantID, ActorID: context.ActorID,
			TraceID: context.TraceID, ToolName: options.ToolName, ToolVersion: options.ToolVersion,
			IdempotencyKey: options.IdempotencyKey, Status: "queued", CreatedAt: now, UpdatedAt: now,
			Attempt: 1, Retry: defaultRetry(options.MaxRetries), Accounting: defaultAccounting(), AuditID: generatedID("audit"),
		}
		service.Store.tools[result.ToolExecutionID] = result
		service.Store.idempotency[scope] = result.ToolExecutionID
		service.auditLocked(context, "tool.create", "tool_execution", result.ToolExecutionID, "accepted")
	})
	return result, duplicate, operationErr
}

func (service *AgentRuntimeService) Run(context TenantContext, id string) (AgentRun, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return AgentRun{}, err
	}
	var result AgentRun
	var operationErr error
	service.Store.withLock(func() {
		result, operationErr = service.ownedRunLocked(context, id)
	})
	return result, operationErr
}

func (service *AgentRuntimeService) Tool(context TenantContext, id string) (ToolExecution, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return ToolExecution{}, err
	}
	var result ToolExecution
	var operationErr error
	service.Store.withLock(func() {
		result, operationErr = service.ownedToolLocked(context, id)
	})
	return result, operationErr
}

func (service *AgentRuntimeService) TransitionRun(context TenantContext, id, to string, approvalRequestID string) (AgentRun, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return AgentRun{}, err
	}
	var result AgentRun
	service.Store.withLock(func() {
		result, err = service.transitionRunLocked(context, id, to, approvalRequestID)
	})
	return result, err
}

func (service *AgentRuntimeService) TransitionTool(context TenantContext, id, to string, approvalRequestID string) (ToolExecution, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return ToolExecution{}, err
	}
	var result ToolExecution
	service.Store.withLock(func() {
		result, err = service.transitionToolLocked(context, id, to, approvalRequestID)
	})
	return result, err
}

func (service *AgentRuntimeService) PauseForApproval(context TenantContext, id, approvalRequestID, kind string) (string, error) {
	if !nameID.MatchString(approvalRequestID) {
		return "", runtimeError("APPROVAL_REQUIRED", "Approval reference is required.")
	}
	if kind == "run" {
		record, err := service.TransitionRun(context, id, "waiting_approval", approvalRequestID)
		return record.Status, err
	}
	record, err := service.TransitionTool(context, id, "waiting_approval", approvalRequestID)
	return record.Status, err
}

func (service *AgentRuntimeService) WaitForRetry(context TenantContext, id, errorCode string, backoffMS int, kind string) (string, error) {
	if backoffMS < 0 || errorCode == "" {
		return "", runtimeError("RETRY_NOT_ALLOWED", "Retry metadata is invalid.")
	}
	context, err := ValidateTenantContext(context)
	if err != nil {
		return "", err
	}
	var status string
	service.Store.withLock(func() {
		if kind == "run" {
			record, lookupErr := service.ownedRunLocked(context, id)
			if lookupErr != nil {
				err = lookupErr
				return
			}
			to := "waiting_retry"
			if record.Retry.RetryCount >= record.Retry.MaxRetries {
				to = "failed"
			}
			record, transitionErr := service.transitionRunLocked(context, id, to, "")
			if transitionErr != nil {
				err = transitionErr
				return
			}
			record.Retry.Retryable, record.Retry.LastErrorCode = to == "waiting_retry", stringPointer(errorCode)
			record.Retry.BackoffMS = intPointer(backoffMS)
			record.Failure = &Failure{Category: "transient_infrastructure", Code: errorCode, Retryable: to == "waiting_retry", Message: "Execution can be retried."}
			service.Store.runs[id] = record
			status = record.Status
			return
		}
		record, lookupErr := service.ownedToolLocked(context, id)
		if lookupErr != nil {
			err = lookupErr
			return
		}
		to := "waiting_retry"
		if record.Retry.RetryCount >= record.Retry.MaxRetries {
			to = "failed"
		}
		record, transitionErr := service.transitionToolLocked(context, id, to, "")
		if transitionErr != nil {
			err = transitionErr
			return
		}
		record.Retry.Retryable, record.Retry.LastErrorCode = to == "waiting_retry", stringPointer(errorCode)
		record.Retry.BackoffMS = intPointer(backoffMS)
		record.Failure = &Failure{Category: "transient_infrastructure", Code: errorCode, Retryable: to == "waiting_retry", Message: "Execution can be retried."}
		service.Store.tools[id] = record
		status = record.Status
	})
	return status, err
}

func (service *AgentRuntimeService) Resume(context TenantContext, id, kind string) (string, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return "", err
	}
	var status string
	service.Store.withLock(func() {
		if kind == "run" {
			record, lookupErr := service.ownedRunLocked(context, id)
			if lookupErr != nil {
				err = lookupErr
				return
			}
			if !service.authorized(context, record.AgentRunID) {
				err = runtimeError("TENANT_AUTHORIZATION_REVOKED", "Current authorization does not permit resume.")
				return
			}
			if record.Status == "waiting_approval" && !service.approved(context, record.ApprovalRequestID, "", "", "") {
				err = runtimeError("APPROVAL_INVALID", "Approval reference is missing or invalid.")
				return
			}
			record, err = service.transitionRunLocked(context, id, "running", "")
			status = record.Status
			return
		}
		record, lookupErr := service.ownedToolLocked(context, id)
		if lookupErr != nil {
			err = lookupErr
			return
		}
		if !service.authorized(context, record.ToolExecutionID) {
			err = runtimeError("TENANT_AUTHORIZATION_REVOKED", "Current authorization does not permit resume.")
			return
		}
		if record.Status == "waiting_approval" && !service.approved(context, record.ApprovalRequestID, record.ToolName, record.ToolVersion, record.IdempotencyKey) {
			err = runtimeError("APPROVAL_INVALID", "Approval reference is missing or invalid.")
			return
		}
		record, err = service.transitionToolLocked(context, id, "running", "")
		status = record.Status
	})
	return status, err
}

func (service *AgentRuntimeService) Retry(context TenantContext, id string) (ToolExecution, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return ToolExecution{}, err
	}
	var next ToolExecution
	service.Store.withLock(func() {
		current, lookupErr := service.ownedToolLocked(context, id)
		if lookupErr != nil {
			err = lookupErr
			return
		}
		if current.Status != "waiting_retry" || !current.Retry.Retryable || current.Retry.RetryCount >= current.Retry.MaxRetries ||
			!service.authorized(context, current.ToolExecutionID) {
			err = runtimeError("RETRY_NOT_ALLOWED", "ToolExecution is not eligible for retry.")
			return
		}
		if current.ApprovalRequestID != "" && !service.approved(context, current.ApprovalRequestID, current.ToolName, current.ToolVersion, current.IdempotencyKey) {
			err = runtimeError("APPROVAL_INVALID", "Approval reference is missing or invalid.")
			return
		}
		next = current
		now := mustTime()
		next.ToolExecutionID, next.AuditID, next.Status = generatedID("exec"), generatedID("audit"), "running"
		next.Attempt, next.Retry.RetryCount = current.Attempt+1, current.Retry.RetryCount+1
		next.Retry.NextRetryAt, next.UpdatedAt, next.StartedAt, next.EndedAt, next.Failure = nil, now, &now, nil, nil
		service.Store.tools[next.ToolExecutionID] = next
		service.auditLocked(context, "tool.retry", "tool_execution", next.ToolExecutionID, "accepted")
	})
	return next, err
}

func (service *AgentRuntimeService) Cancel(context TenantContext, id, kind string) (string, error) {
	if kind == "run" {
		record, err := service.Run(context, id)
		if err != nil {
			return "", err
		}
		if record.Status == "running" {
			record, err = service.TransitionRun(context, id, "cancel_requested", "")
		} else {
			record, err = service.TransitionRun(context, id, "cancelled", "")
		}
		return record.Status, err
	}
	record, err := service.Tool(context, id)
	if err != nil {
		return "", err
	}
	if record.Status == "running" {
		record, err = service.TransitionTool(context, id, "cancel_requested", "")
	} else {
		record, err = service.TransitionTool(context, id, "cancelled", "")
	}
	return record.Status, err
}

func (service *AgentRuntimeService) ConfirmCancellation(context TenantContext, id, kind string) (string, error) {
	if kind == "run" {
		record, err := service.TransitionRun(context, id, "cancelled", "")
		return record.Status, err
	}
	record, err := service.TransitionTool(context, id, "cancelled", "")
	return record.Status, err
}

func (service *AgentRuntimeService) Recover(context TenantContext) ([]string, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return nil, err
	}
	recovered := []string{}
	service.Store.withLock(func() {
		for id, record := range service.Store.runs {
			if ownership(context, record.TenantID, record.ActorID, record.TraceID) && record.Status == "running" {
				service.recoverRunLocked(context, id, record)
				recovered = append(recovered, id)
			}
		}
		for id, record := range service.Store.tools {
			if ownership(context, record.TenantID, record.ActorID, record.TraceID) && record.Status == "running" {
				service.recoverToolLocked(context, id, record)
				recovered = append(recovered, id)
			}
		}
	})
	return recovered, nil
}

func (service *AgentRuntimeService) RecordAudit(context TenantContext, action, targetType, targetID, outcome string) (string, error) {
	context, err := ValidateTenantContext(context)
	if err != nil {
		return "", err
	}
	var id string
	service.Store.withLock(func() { id = service.auditLocked(context, action, targetType, targetID, outcome) })
	return id, nil
}

func (service *AgentRuntimeService) ownedRunLocked(context TenantContext, id string) (AgentRun, error) {
	record, ok := service.Store.runs[id]
	if !ok || !ownership(context, record.TenantID, record.ActorID, record.TraceID) {
		return AgentRun{}, runtimeError("RUNTIME_NOT_FOUND", "AgentRun is not visible in this tenant.")
	}
	return record, nil
}

func (service *AgentRuntimeService) ownedToolLocked(context TenantContext, id string) (ToolExecution, error) {
	record, ok := service.Store.tools[id]
	if !ok || !ownership(context, record.TenantID, record.ActorID, record.TraceID) {
		return ToolExecution{}, runtimeError("RUNTIME_NOT_FOUND", "ToolExecution is not visible in this tenant.")
	}
	return record, nil
}

func (service *AgentRuntimeService) transitionRunLocked(context TenantContext, id, to, approval string) (AgentRun, error) {
	record, err := service.ownedRunLocked(context, id)
	if err != nil {
		return AgentRun{}, err
	}
	if !runTransition(record.Status, to) {
		service.auditLocked(context, "lifecycle.transition", "agent_run", id, "rejected")
		return AgentRun{}, runtimeError("LIFECYCLE_ILLEGAL_TRANSITION", "Illegal AgentRun transition.")
	}
	if to == "waiting_approval" && !nameID.MatchString(approval) {
		return AgentRun{}, runtimeError("APPROVAL_REQUIRED", "Approval reference is required.")
	}
	now := mustTime()
	record.Status, record.UpdatedAt = to, now
	if to == "running" && record.StartedAt == nil {
		record.StartedAt = &now
	}
	if runTerminal(to) {
		record.EndedAt = &now
	}
	if approval != "" {
		record.ApprovalRequestID = approval
	}
	service.Store.runs[id] = record
	service.auditLocked(context, "lifecycle.transition", "agent_run", id, "accepted")
	return record, nil
}

func (service *AgentRuntimeService) transitionToolLocked(context TenantContext, id, to, approval string) (ToolExecution, error) {
	record, err := service.ownedToolLocked(context, id)
	if err != nil {
		return ToolExecution{}, err
	}
	if !toolTransition(record.Status, to) {
		service.auditLocked(context, "lifecycle.transition", "tool_execution", id, "rejected")
		return ToolExecution{}, runtimeError("LIFECYCLE_ILLEGAL_TRANSITION", "Illegal ToolExecution transition.")
	}
	if to == "waiting_approval" && !nameID.MatchString(approval) {
		return ToolExecution{}, runtimeError("APPROVAL_REQUIRED", "Approval reference is required.")
	}
	now := mustTime()
	record.Status, record.UpdatedAt = to, now
	if to == "running" && record.StartedAt == nil {
		record.StartedAt = &now
	}
	if toolTerminal(to) {
		record.EndedAt = &now
	}
	if approval != "" {
		record.ApprovalRequestID = approval
	}
	service.Store.tools[id] = record
	service.auditLocked(context, "lifecycle.transition", "tool_execution", id, "accepted")
	return record, nil
}

func (service *AgentRuntimeService) auditLocked(context TenantContext, action, targetType, targetID, outcome string) string {
	id := generatedID("audit")
	service.Store.audit = append(service.Store.audit, AuditRecord{
		AuditID: id, ContractVersion: ContractVersion, TenantID: context.TenantID, ActorID: context.ActorID,
		ActorType: context.ActorType, TraceID: context.TraceID, OriginKind: context.RequestOrigin.Kind,
		Action: action, TargetType: targetType, TargetID: targetID, Outcome: outcome, CreatedAt: mustTime(),
	})
	return id
}

func (service *AgentRuntimeService) approved(context TenantContext, approval, tool, toolVersion, key string) bool {
	return approval != "" && service.ApprovalValidator(context, ApprovalBinding{ApprovalRequestID: approval, ToolName: tool, ToolVersion: toolVersion, IdempotencyKey: key})
}

func (service *AgentRuntimeService) authorized(context TenantContext, id string) bool {
	return service.AuthorizationValidator(context, id)
}

func (service *AgentRuntimeService) recoverRunLocked(context TenantContext, id string, record AgentRun) {
	now := mustTime()
	if record.Retry.Retryable && record.Retry.RetryCount < record.Retry.MaxRetries {
		record.Status, record.Retry.LastErrorCode = "waiting_retry", stringPointer("RUNTIME_WORKER_RESTART")
	} else {
		record.Status, record.EndedAt = "failed", &now
		record.Failure = &Failure{Category: "transient_infrastructure", Code: "RUNTIME_WORKER_RESTART", Message: "Execution stopped during worker recovery."}
	}
	record.UpdatedAt = now
	service.Store.runs[id] = record
	service.auditLocked(context, "runtime.recover", "agent_run", id, "accepted")
}

func (service *AgentRuntimeService) recoverToolLocked(context TenantContext, id string, record ToolExecution) {
	now := mustTime()
	if record.Retry.Retryable && record.Retry.RetryCount < record.Retry.MaxRetries {
		record.Status, record.Retry.LastErrorCode = "waiting_retry", stringPointer("RUNTIME_WORKER_RESTART")
	} else {
		record.Status, record.EndedAt = "failed", &now
		record.Failure = &Failure{Category: "transient_infrastructure", Code: "RUNTIME_WORKER_RESTART", Message: "Execution stopped during worker recovery."}
	}
	record.UpdatedAt = now
	service.Store.tools[id] = record
	service.auditLocked(context, "runtime.recover", "tool_execution", id, "accepted")
}

func runTerminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}
func toolTerminal(status string) bool {
	return status == "succeeded" || status == "failed" || status == "cancelled"
}
func runTransition(from, to string) bool {
	return map[string]map[string]bool{
		"queued":           {"running": true, "cancelled": true},
		"running":          {"waiting_approval": true, "waiting_retry": true, "cancel_requested": true, "completed": true, "failed": true},
		"waiting_approval": {"running": true, "cancelled": true},
		"waiting_retry":    {"running": true, "cancelled": true, "failed": true},
		"cancel_requested": {"cancelled": true},
	}[from][to]
}
func toolTransition(from, to string) bool {
	return map[string]map[string]bool{
		"queued":           {"running": true, "cancelled": true},
		"running":          {"waiting_approval": true, "waiting_retry": true, "cancel_requested": true, "succeeded": true, "failed": true},
		"waiting_approval": {"running": true, "cancelled": true},
		"waiting_retry":    {"running": true, "cancelled": true, "failed": true},
		"cancel_requested": {"cancelled": true},
	}[from][to]
}
func stringPointer(value string) *string { return &value }
func intPointer(value int) *int          { return &value }
