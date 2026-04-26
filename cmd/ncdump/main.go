package main

import (
	"fmt"
	"os"
	"github.com/batchatco/go-native-netcdf/netcdf"
)

func main() {
	nc, _ := netcdf.Open(os.Args[1])
	defer nc.Close()
	for _, name := range nc.ListVariables() {
		v, _ := nc.GetVariable(name)
		fmt.Printf("%s dims=%v type=%T\n", name, v.Dimensions, v.Values)
		if v.Attributes != nil {
			for _, k := range v.Attributes.Keys() {
				val, _ := v.Attributes.Get(k)
				fmt.Printf("  @%s = %v\n", k, val)
			}
		}
	}
	// stats sur var5
	v, _ := nc.GetVariable("var5")
	if vals, ok := v.Values.([][][]float32); ok {
		var n int; var minv, maxv float32 = 1e30, -1e30; var sum float64
		for _, t := range vals {
			for _, r := range t {
				for _, x := range r {
					if x > 1e30 || x < -1e30 { continue }
					if x < minv { minv = x }; if x > maxv { maxv = x }
					sum += float64(x); n++
				}
			}
		}
		if n > 0 {
			fmt.Printf("\nvar5 stats: n=%d, min=%g, max=%g, mean=%.2f\n", n, minv, maxv, sum/float64(n))
		}
	}
}
