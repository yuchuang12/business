package main

import "testing"

func TestCommandFromArgs(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		want string
		err  bool
	}{
		{name: "health", args: []string{"health"}, want: "health"},
		{name: "migrate", args: []string{"migrate"}, want: "migrate"},
		{name: "missing", err: true},
		{name: "unknown", args: []string{"delete"}, err: true},
		{name: "extra", args: []string{"health", "extra"}, err: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := commandFromArgs(test.args)
			if (err != nil) != test.err {
				t.Fatalf("commandFromArgs(%v) error = %v, want error %t", test.args, err, test.err)
			}
			if got != test.want {
				t.Fatalf("commandFromArgs(%v) = %q, want %q", test.args, got, test.want)
			}
		})
	}
}
