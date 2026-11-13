package main

import "log"

func logWarn(format string, args ...any)  { log.Printf("WARN "+format, args...) }
func logError(format string, args ...any) { log.Printf("ERROR "+format, args...) }
