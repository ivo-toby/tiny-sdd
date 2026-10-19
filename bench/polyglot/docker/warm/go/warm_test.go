package warm

import (
	"testing"
)

func TestDescribe(t *testing.T) {
	if Describe([]string{"b", "a"}) == "" {
		t.Fatal("empty")
	}
}
