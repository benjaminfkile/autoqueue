## AWS Secrets Manager

App secrets (`AWS_SECRET_ARN`):
```json
{
  "NODE_ENV": "production",
  "PORT": "8000",
  "API_KEY_HASH": "bcrypt-hash-of-your-api-key",
  "GH_PAT": "github_pat_...",
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "REPOS_PATH": "/data/repos",
  "POLL_INTERVAL_SECONDS": "300"
}
```

## Database

Grunt uses an embedded SQLite database (via `better-sqlite3`). No external database server is required — the file is created automatically on first run inside the OS-standard user data directory:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\grunt\grunt.sqlite` (typically `C:\Users\<you>\AppData\Roaming\grunt\grunt.sqlite`) |
| macOS | `~/Library/Application Support/grunt/grunt.sqlite` |
| Linux | `$XDG_DATA_HOME/grunt/grunt.sqlite` (defaults to `~/.local/share/grunt/grunt.sqlite`) |

WAL mode and `foreign_keys = ON` are enabled on every connection. To redirect the database to a different file (useful for tests or ad-hoc tooling), set `GRUNT_DB_PATH` to an absolute file path before starting the API.

## Windows Boot Startup Task

Use this repo script to create/update the `GRUNT` scheduled task at system boot without storing any password in source control.

1. Open **Administrator PowerShell**.
2. Run:

```powershell
.\scripts\windows\create-grunt-startup-task.ps1
```

Optional parameters:

```powershell
.\scripts\windows\create-grunt-startup-task.ps1 `
  -TaskName "GRUNT" `
  -RunAsUser "$env:USERDOMAIN\$env:USERNAME" `
  -ProjectDir (Get-Location).Path `
  -StartupDelay "PT30S"
```

By default, the script creates both:
- At startup trigger (with delay)
- At logon trigger for the run-as user

Disable the logon trigger if needed:

```powershell
.\scripts\windows\create-grunt-startup-task.ps1 -IncludeLogonTrigger:$false
```

Notes:
- The script prompts for the account password via `Get-Credential`.
- No password or token is hardcoded.
- The task runs `scripts\\windows\\start-grunt-api.cmd`, which starts the API and logs to `api.log`.

## Applying Updates

To pull changes, rebuild, and restart the service:

1. Open **Administrator PowerShell**.
2. Stop the running task:
```powershell
Stop-ScheduledTask -TaskName "GRUNT"
```
3. Pull latest changes and rebuild:
```powershell
cd C:\path\to\grunt
git pull
node .\node_modules\typescript\bin\tsc
```
4. Restart the task:
```powershell
Start-ScheduledTask -TaskName "GRUNT"
```

To verify it's running:
```powershell
Get-ScheduledTask -TaskName "GRUNT" | Select-Object TaskName, State
```

Logs are written to `api.log` in the project root.
