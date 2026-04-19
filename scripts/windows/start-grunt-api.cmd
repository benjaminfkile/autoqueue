@echo off
setlocal

for %%I in ("%~dp0\..\..") do set "PROJECT_DIR=%%~fI"
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
set "TSC_CMD=%PROJECT_DIR%\node_modules\.bin\tsc.cmd"

cd /d "%PROJECT_DIR%"

if not exist "%PROJECT_DIR%\dist\index.js" (
	echo [startup] dist/index.js missing. Building TypeScript... >> "%PROJECT_DIR%\api.log"
	if exist "%TSC_CMD%" (
		call "%TSC_CMD%" >> "%PROJECT_DIR%\api.log" 2>&1
	) else (
		echo [startup] ERROR: TypeScript compiler not found at %TSC_CMD% >> "%PROJECT_DIR%\api.log"
		exit /b 1
	)
)

"%NODE_EXE%" "%PROJECT_DIR%\dist\index.js" >> "%PROJECT_DIR%\api.log" 2>&1
