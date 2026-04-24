## AWS Secrets Manager

App secrets (`AWS_SECRET_ARN`):
```json
{
  "NODE_ENV": "production",
  "PORT": "8000",
  "DB_NAME": "grunt",
  "DB_HOST": "your-db-host",
  "API_KEY_HASH": "bcrypt-hash-of-your-api-key",
  "GH_PAT": "github_pat_...",
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "REPOS_PATH": "/data/repos",
  "POLL_INTERVAL_SECONDS": "300"
}
```

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
