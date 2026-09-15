// The Go half of the cross-client conformance battery.
//
// Runs the same scenarios as battery.mjs and battery.py against the same peer.
// This is the only driver in a different language runtime, so it has its own
// JSON encoder, HTTP client and SSE parser: every assumption shared between a
// Node gateway and a Node client is absent here.
//
// Usage: battery <url> <http|sse>
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	separators = "before\u2028middle\u2029after"
	unicodeStr = "a👩‍👩‍👧‍👦b عربى c éèê d 漢字 e 𝔘𝔫𝔦 f"
	plain      = "plain-result"
)

type result struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

var results []result

func record(name string, ok bool, detail string) {
	results = append(results, result{Name: name, OK: ok, Detail: detail})
}

func textOf(res *mcp.CallToolResult) string {
	if res == nil {
		return ""
	}
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			return tc.Text
		}
	}
	return ""
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func main() {
	url, kind := os.Args[1], os.Args[2]
	bigLength := 1024 * 1024
	if v := os.Getenv("BIG_LENGTH"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			bigLength = n
		}
	}

	defer func() {
		out, _ := json.Marshal(results)
		fmt.Println(string(out))
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client := mcp.NewClient(&mcp.Implementation{Name: "battery-go", Version: "1.0.0"}, nil)
	var transport mcp.Transport
	if kind == "sse" {
		transport = mcp.NewSSEClientTransport(url, nil)
	} else {
		transport = mcp.NewStreamableClientTransport(url, nil)
	}

	session, err := client.Connect(ctx, transport)
	if err != nil {
		record("connect", false, clip(err.Error(), 100))
		return
	}
	defer session.Close()
	record("connect", true, "")

	// tools/list
	if tools, err := session.ListTools(ctx, nil); err != nil {
		record("tools/list", false, clip(err.Error(), 60))
	} else {
		var names []string
		for _, t := range tools.Tools {
			names = append(names, t.Name)
		}
		sort.Strings(names)
		want := []string{"echo", "large", "plain", "separators", "shadowedError",
			"slow", "throws", "toolError", "unicode"}
		got, _ := json.Marshal(names)
		wantJSON, _ := json.Marshal(want)
		record("tools/list", string(got) == string(wantJSON), string(got))
	}

	simple := []struct{ label, tool, expect string }{
		{"plain text", "plain", plain},
		{"line separators", "separators", separators},
		{"unicode", "unicode", unicodeStr},
	}
	for _, c := range simple {
		res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: c.tool})
		if err != nil {
			record(c.label, false, clip(err.Error(), 60))
			continue
		}
		got := textOf(res)
		record(c.label, got == c.expect, clip(strconv.Quote(got), 60))
	}

	if res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "large"}); err != nil {
		record(fmt.Sprintf("1 MB result"), false, clip(err.Error(), 70))
	} else {
		got := textOf(res)
		record("1 MB result", len(got) == bigLength, fmt.Sprintf("length %d", len(got)))
	}

	if res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "toolError"}); err != nil {
		record("tool error stays a result", false, "threw: "+clip(err.Error(), 50))
	} else {
		record("tool error stays a result", res.IsError, fmt.Sprintf("isError=%v", res.IsError))
	}

	if res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "throws"}); err != nil {
		record("throwing tool reported", true, "rejected: "+clip(err.Error(), 40))
	} else {
		record("throwing tool reported", res.IsError || textOf(res) != "",
			fmt.Sprintf("isError=%v", res.IsError))
	}

	args := map[string]any{
		"text":   unicodeStr,
		"number": -0.5,
		"flag":   false,
		"nested": map[string]any{"a": []any{1, nil, true}, "b": map[string]any{"c": separators}},
	}
	if res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "echo", Arguments: args}); err != nil {
		record("arguments round trip", false, clip(err.Error(), 60))
	} else {
		var got map[string]any
		_ = json.Unmarshal([]byte(textOf(res)), &got)
		wantJSON, _ := json.Marshal(args)
		gotJSON, _ := json.Marshal(got)
		record("arguments round trip", string(gotJSON) == string(wantJSON), clip(string(gotJSON), 70))
	}

	started := time.Now()
	if res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "slow"}); err != nil {
		record("slow call completes", false, clip(err.Error(), 60))
	} else {
		record("slow call completes", textOf(res) == "slow-done",
			fmt.Sprintf("%dms", time.Since(started).Milliseconds()))
	}

	if res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "shadowedError"}); err != nil {
		record("result with an error field", false, clip(err.Error(), 60))
	} else {
		record("result with an error field", textOf(res) == "ok", strconv.Quote(textOf(res)))
	}

	// five concurrent calls
	type outcome struct {
		text string
		err  error
	}
	ch := make(chan outcome, 5)
	for i := 0; i < 5; i++ {
		go func() {
			res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "plain"})
			ch <- outcome{textOf(res), err}
		}()
	}
	allOK := true
	for i := 0; i < 5; i++ {
		o := <-ch
		if o.err != nil || o.text != plain {
			allOK = false
		}
	}
	record("5 concurrent calls", allOK, "5 replies")

	if res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "noSuchTool"}); err != nil {
		record("unknown tool errors", true, "rejected: "+clip(err.Error(), 40))
	} else {
		record("unknown tool errors", res.IsError, fmt.Sprintf("isError=%v", res.IsError))
	}
}
