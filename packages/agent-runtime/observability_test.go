package agentruntime

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestRuntimeMetricsExcludeCorrelationFields(t *testing.T) {
	metrics := NewRuntimeMetrics()
	metrics.RecordRuntimeEvent(RuntimeEvent{Operation: "tool.transition", Outcome: "accepted", TenantID: "tenant_a", TraceID: strings.Repeat("a", 32)})
	metrics.RecordRuntimeEvent(RuntimeEvent{Operation: "tool.transition", Outcome: "accepted", TenantID: "tenant_b", TraceID: strings.Repeat("b", 32)})

	snapshot := metrics.Snapshot()
	if got := snapshot[RuntimeMetricKey{Operation: "tool.transition", Outcome: "accepted"}]; got != 2 {
		t.Fatalf("metric count = %d, want 2", got)
	}
}

func TestSlogRuntimeObserverDoesNotAcceptPayloads(t *testing.T) {
	var output bytes.Buffer
	observer := SlogRuntimeObserver{Logger: slog.New(slog.NewJSONHandler(&output, nil))}
	observer.RecordRuntimeEvent(RuntimeEvent{
		Operation: "provider.reconcile", Outcome: "accepted", TenantID: "tenant_a",
		TraceID: strings.Repeat("a", 32), CorrelationID: "correlation_100",
	})
	log := output.String()
	for _, expected := range []string{`"tenant_id":"tenant_a"`, `"trace_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`, `"correlation_id":"correlation_100"`} {
		if !strings.Contains(log, expected) {
			t.Fatalf("log missing %s: %s", expected, log)
		}
	}
	if strings.Contains(log, "payload") || strings.Contains(log, "credential") {
		t.Fatalf("log included unsafe field: %s", log)
	}
}
