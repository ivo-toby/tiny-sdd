package warm

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

func Describe(values []string) string {
	sort.Strings(values)
	return fmt.Sprint(strings.Join(values, ","), reflect.TypeOf(values), errors.New("warm"))
}
