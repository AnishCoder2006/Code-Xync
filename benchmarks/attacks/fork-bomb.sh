#!/bin/sh
# Attack payload: fork bomb. Must be contained by --pids-limit (design doc 3.1).
:(){ :|:& };:
