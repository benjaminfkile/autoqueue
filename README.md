## Security Model

Grunt is a single-user desktop application. The API server binds to `127.0.0.1` only and is not reachable from other machines on the network. There is no authentication layer — the OS user boundary is the security model.

## Requirements

### Docker

Grunt runs every task inside a Docker container, so a working Docker installation is **required**. The `docker` CLI must be on `PATH` and the daemon must be reachable — Grunt halts the task scheduler and surfaces an in-app banner whenever it can't reach Docker.

| Platform | Install |
| --- | --- |
| macOS | [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/) |
| Windows | [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) |
| Linux | [Docker Engine](https://docs.docker.com/engine/install/) (Docker Desktop for Linux also works) |

#### First-run build delay

The first task you run after installing or updating Grunt triggers a local build of the `grunt/runner` image (the container image with the Claude CLI pre-installed). This build can take **several minutes** depending on your network and machine — subsequent runs reuse the cached image and start in seconds. The build is content-addressed by the Dockerfile contents, so it only re-runs when the runner image definition changes.

Progress for this initial build is visible in the Grunt UI; tasks queued during the build start automatically as soon as the image is ready.

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
