// runtime-admin performs database-only operational actions for the Agent Runtime.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	agentruntime "github.com/yuchuang12/business/packages/agent-runtime"
)

const defaultTimeout = 30 * time.Second

func main() {
	if err := run(os.Args[1:]); err != nil {
		// Do not print driver errors: they can include connection details.
		fmt.Fprintln(os.Stderr, "runtime database operation failed")
		os.Exit(1)
	}
}

func run(args []string) error {
	command, err := commandFromArgs(args)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()

	db, err := agentruntime.OpenPostgres(ctx, agentruntime.PostgresConfigFromEnv())
	if err != nil {
		return err
	}
	defer db.Close()

	switch command {
	case "health":
		fmt.Println("runtime database is ready")
		return nil
	case "migrate":
		if err := agentruntime.Migrate(ctx, db); err != nil {
			return err
		}
		fmt.Println("runtime database migrations are current")
		return nil
	default:
		return errors.New("unsupported command")
	}
}

func commandFromArgs(args []string) (string, error) {
	if len(args) != 1 {
		return "", errors.New("usage: runtime-admin <health|migrate>")
	}
	if args[0] != "health" && args[0] != "migrate" {
		return "", errors.New("usage: runtime-admin <health|migrate>")
	}
	return args[0], nil
}
