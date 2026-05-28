@echo off
rem Shared production memory / safety defaults (must be set before node starts).
if not defined NODE_OPTIONS set NODE_OPTIONS=--max-old-space-size=650 --expose-gc
if not defined RUST_HOTPATH_ENABLED set RUST_HOTPATH_ENABLED=false
