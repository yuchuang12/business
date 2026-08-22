package agentruntime

import (
	"log/slog"
	"sync"
	"time"
)

// RuntimeEvent contains only lifecycle metadata that is safe to emit to logs
// and metrics. It deliberately has no request, provider, or model payload.
type RuntimeEvent struct {
	Timestamp       time.Time
	Operation       string
	Outcome         string
	TenantID        string
	TraceID         string
	CorrelationID   string
	AgentRunID      string
	ToolExecutionID string
	ApprovalID      string
	ProviderState   ProviderEffectState
	ErrorCode       string
	LatencyMS       int
}

// RuntimeObserver receives lifecycle events after their durable operation has
// completed. Implementations must not retain or emit raw business payloads.
type RuntimeObserver interface {
	RecordRuntimeEvent(RuntimeEvent)
}

type RuntimeMetricKey struct {
	Operation     string
	Outcome       string
	ErrorCode     string
	ProviderState ProviderEffectState
}

// RuntimeMetrics is an in-process metrics collector suitable for exporting via
// the application's metrics adapter. Tenant and trace identifiers are excluded
// from metric keys to prevent sensitive high-cardinality labels.
type RuntimeMetrics struct {
	mu     sync.RWMutex
	counts map[RuntimeMetricKey]uint64
}

func NewRuntimeMetrics() *RuntimeMetrics {
	return &RuntimeMetrics{counts: make(map[RuntimeMetricKey]uint64)}
}

func (metrics *RuntimeMetrics) RecordRuntimeEvent(event RuntimeEvent) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.counts[RuntimeMetricKey{
		Operation: event.Operation, Outcome: event.Outcome,
		ErrorCode: event.ErrorCode, ProviderState: event.ProviderState,
	}]++
}

func (metrics *RuntimeMetrics) Snapshot() map[RuntimeMetricKey]uint64 {
	metrics.mu.RLock()
	defer metrics.mu.RUnlock()
	snapshot := make(map[RuntimeMetricKey]uint64, len(metrics.counts))
	for key, value := range metrics.counts {
		snapshot[key] = value
	}
	return snapshot
}

// SlogRuntimeObserver emits structured diagnostic events with the correlation
// fields operators need, without accepting arbitrary attributes or payloads.
type SlogRuntimeObserver struct {
	Logger *slog.Logger
}

func (observer SlogRuntimeObserver) RecordRuntimeEvent(event RuntimeEvent) {
	logger := observer.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.LogAttrs(nil, slog.LevelInfo, "agent runtime lifecycle",
		slog.String("operation", event.Operation),
		slog.String("outcome", event.Outcome),
		slog.String("tenant_id", event.TenantID),
		slog.String("trace_id", event.TraceID),
		slog.String("correlation_id", event.CorrelationID),
		slog.String("agent_run_id", event.AgentRunID),
		slog.String("tool_execution_id", event.ToolExecutionID),
		slog.String("approval_id", event.ApprovalID),
		slog.String("provider_state", string(event.ProviderState)),
		slog.String("error_code", event.ErrorCode),
		slog.Int("latency_ms", event.LatencyMS),
	)
}

type runtimeObserverGroup []RuntimeObserver

func (group runtimeObserverGroup) RecordRuntimeEvent(event RuntimeEvent) {
	for _, observer := range group {
		if observer != nil {
			observer.RecordRuntimeEvent(event)
		}
	}
}
