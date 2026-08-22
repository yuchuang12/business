package agentruntime

import (
	"context"
	"database/sql"
	"testing"
)

func TestPostgresConfigRequiresDatabase(t *testing.T) {
	if _, err := (PostgresConfig{User: "runtime"}).connectionString(); err == nil {
		t.Fatal("expected incomplete postgres configuration to fail")
	}
}

func TestMigrateRequiresDatabase(t *testing.T) {
	if err := Migrate(context.Background(), (*sql.DB)(nil)); err == nil {
		t.Fatal("expected nil database to fail")
	}
}

func TestWithDatabasePreservesConnectionOptions(t *testing.T) {
	got, err := withDatabase("postgres://user:pass@localhost:5432/template?sslmode=disable", "isolated")
	if err != nil {
		t.Fatal(err)
	}
	want := "postgres://user:pass@localhost:5432/isolated?sslmode=disable"
	if got != want {
		t.Fatalf("database URL = %q, want %q", got, want)
	}
}
