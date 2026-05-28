@echo off
echo Building latest dist...
call npm run build
if errorlevel 1 (
  echo Build failed — fix TypeScript errors before launch.
  exit /b 1
)
exit /b 0
