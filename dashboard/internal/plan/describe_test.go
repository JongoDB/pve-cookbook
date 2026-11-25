package plan

import "testing"

func TestPlainDescription(t *testing.T) {
	for in, want := range map[string]string{
		"Set virtual machine options (synchronous API) - You should consider using the POST method instead for any actions involving hotplug or storage allocation.": "Set virtual machine options",
		"Create a new hardware mapping.":       "Create a new hardware mapping",
		"Create or restore a virtual machine.": "Create or restore a virtual machine",
	} {
		if got := plainDescription(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}
