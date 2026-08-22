package agentruntime

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

//go:embed migrations/001_agent_runtime.sql
var agentRuntimeMigrationFS embed.FS

const agentRuntimeMigration = "001_agent_runtime.sql"

// PostgresConfig is the production connection configuration. URL takes
// precedence; the remaining fields are used to build a URL when it is absent.
type PostgresConfig struct {
	URL             string
	Host            string
	Port            string
	User            string
	Password        string
	Database        string
	SSLMode         string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
}

func PostgresConfigFromEnv() PostgresConfig {
	return PostgresConfig{
		URL: os.Getenv("DATABASE_URL"), Host: os.Getenv("PGHOST"), Port: os.Getenv("PGPORT"),
		User: os.Getenv("PGUSER"), Password: os.Getenv("PGPASSWORD"), Database: os.Getenv("PGDATABASE"),
		SSLMode: os.Getenv("PGSSLMODE"),
	}
}

func (config PostgresConfig) connectionString() (string, error) {
	if config.URL != "" {
		return config.URL, nil
	}
	host, database := config.Host, config.Database
	if host == "" {
		host = "localhost"
	}
	if database == "" || config.User == "" {
		return "", errors.New("postgres configuration requires DATABASE_URL or PGUSER and PGDATABASE")
	}
	port := config.Port
	if port == "" {
		port = "5432"
	}
	sslMode := config.SSLMode
	if sslMode == "" {
		sslMode = "require"
	}
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s",
		config.User, config.Password, host, port, database, sslMode), nil
}

// OpenPostgres opens and pings the shared production database. The caller owns
// the returned DB and must close it during application shutdown.
func OpenPostgres(ctx context.Context, config PostgresConfig) (*sql.DB, error) {
	dsn, err := config.connectionString()
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	if config.MaxOpenConns > 0 {
		db.SetMaxOpenConns(config.MaxOpenConns)
	}
	if config.MaxIdleConns > 0 {
		db.SetMaxIdleConns(config.MaxIdleConns)
	}
	if config.ConnMaxLifetime > 0 {
		db.SetConnMaxLifetime(config.ConnMaxLifetime)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return db, nil
}

// Migrate is the sole owner of agent-runtime schema installation. It is
// intentionally explicit so the service composition root can run it at startup.
func Migrate(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return errors.New("postgres DB is required")
	}
	script, err := agentRuntimeMigrationFS.ReadFile("migrations/" + agentRuntimeMigration)
	if err != nil {
		return fmt.Errorf("read agent-runtime migration: %w", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin agent-runtime migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS agent_runtime_schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("create migration ledger: %w", err)
	}
	var applied bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM agent_runtime_schema_migrations WHERE version = $1)`, agentRuntimeMigration).Scan(&applied); err != nil {
		return fmt.Errorf("read migration ledger: %w", err)
	}
	if !applied {
		if _, err = tx.ExecContext(ctx, string(script)); err != nil {
			return fmt.Errorf("apply %s: %w", agentRuntimeMigration, err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO agent_runtime_schema_migrations(version) VALUES ($1)`, agentRuntimeMigration); err != nil {
			return fmt.Errorf("record %s: %w", agentRuntimeMigration, err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit agent-runtime migration: %w", err)
	}
	return nil
}

// NewPostgresTestDatabase creates a database owned by the test and registers
// cleanup. It requires TEST_DATABASE_ADMIN_URL (or DATABASE_URL) and skips
// when no PostgreSQL test server is configured, keeping CI deterministic.
func NewPostgresTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	adminURL := os.Getenv("TEST_DATABASE_ADMIN_URL")
	if adminURL == "" {
		adminURL = os.Getenv("DATABASE_URL")
	}
	if adminURL == "" {
		t.Skip("TEST_DATABASE_ADMIN_URL or DATABASE_URL is required for PostgreSQL integration tests")
	}
	admin, err := sql.Open("pgx", adminURL)
	if err != nil {
		t.Fatalf("open postgres admin connection: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		t.Fatalf("ping postgres admin connection: %v", err)
	}
	name := "agent_runtime_test_" + strings.ReplaceAll(fmt.Sprintf("%d", time.Now().UnixNano()), "-", "")
	if _, err := admin.ExecContext(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatalf("create isolated postgres database: %v", err)
	}
	databaseURL, err := withDatabase(adminURL, name)
	if err != nil {
		t.Fatalf("build isolated postgres URL: %v", err)
	}
	config := PostgresConfig{URL: databaseURL}
	db, err := OpenPostgres(ctx, config)
	if err != nil {
		t.Fatalf("open isolated postgres database: %v", err)
	}
	if err := Migrate(ctx, db); err != nil {
		_ = db.Close()
		t.Fatalf("migrate isolated postgres database: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
		_, _ = admin.ExecContext(context.Background(), `DROP DATABASE "`+name+`"`)
	})
	return db
}

func withDatabase(rawURL, database string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	parsed.Path = "/" + database
	return parsed.String(), nil
}
