# Relief

Relief, also called FauxCode, is a coding simulator for taking a break. It opens a familiar editor layout with a fictional project, code files, build output, and a terminal. Pressing keys fills the editor with code. Exact-input mode turns it into a typing game with streaks, experience points, and achievements.

The terminal and project files are simulated inside the app. Commands such as git, npm, docker, and ssh produce simulated results. They do not execute system commands or connect to the services shown in the fictional projects.

## Run in a browser

You need Python 3.10 or newer. No Python packages are needed for the browser preview.

From the project folder, run:

```powershell
python tools/serve.py
```

Open [the local preview](http://127.0.0.1:8770/workbench.html). Keep the terminal running while you use it. Press Ctrl+C in that terminal when finished.

You can also open `workbench.html` directly in a browser. The local server is useful during development because it disables caching.

## Run as a Windows app

The desktop version uses Python, pywebview, and Microsoft Edge WebView2. Install the WebView2 Runtime if it is missing from your Windows installation.

Create an environment and install the dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe fauxcode-app/launcher.py
```

The window can be resized, maximized, and minimized. Its size and position are stored in `%APPDATA%\FauxCode\window.json`. Themes, preferences, and game progress use browser storage.

## Build the Windows executable

Close any running FauxCode windows before building. In PowerShell, from the project folder:

```powershell
.\.venv\Scripts\Activate.ps1
.\fauxcode-app\build.bat
```

The build creates `FauxCode.exe` in the project folder. The executable includes the workbench and project profiles. It is not committed to this repository.

If PowerShell blocks environment activation, run the build commands directly:

```powershell
cd fauxcode-app
..\.venv\Scripts\python.exe check_build.py
..\.venv\Scripts\python.exe -m PyInstaller FauxCode.spec
Copy-Item dist/FauxCode.exe ../FauxCode.exe
```

Windows cannot replace an executable while it is running. If a build fails because the file is locked, close the remaining FauxCode process and try again.

## First steps

1. Choose a project from the welcome screen.
2. Click a code file in the explorer.
3. Type to reveal its code.
4. Open the terminal and enter `help` to see the simulated commands.
5. Open Settings to change the theme, font size, word wrapping, or background activity.

There are twelve project profiles: web development, banking, game development, machine learning, mobile development, DevOps, embedded systems, Go services, enterprise Java, blockchain, data engineering, and C++ systems.

## Controls

* Ctrl+Shift+P: command palette.
* Ctrl+P: quick open.
* Ctrl+F: find.
* Ctrl+Shift+O: symbols.
* F12: go to definition.
* F9: toggle a breakpoint.
* F5: start the simulated debugger.
* Ctrl+comma: settings.
* Ctrl+backtick: terminal.
* Ctrl+Alt+G: exact-input typing mode.
* Ctrl+Alt+Z: ambient view. Escape returns to the editor.

The menus also provide split editor, zoom, zen mode, and the Problems, Output, Debug Console, and Ports panels.

## Typing game

Enable exact-input mode with Ctrl+Alt+G or enter `focus on` in the simulated terminal. A trace line shows what to type next. Correct input increases your streak and experience. A mistake resets the streak.

Click the LSP status item to open the scoreboard. Click wavy underlines in the editor to clear simulated issues. The terminal commands `stats` and `achievements` show your progress.

For a quieter break, enter `zen` in the simulated terminal. It offers rain, stars, and waves. Other small terminal features include `neofetch`, `cowsay`, `fortune`, `sl`, and `matrix`.

## Project structure

* `workbench.html`: page layout and base styles.
* `app/engine.js`: editor and core workbench behavior.
* `app/shell.js`: simulated terminal, build activity, achievements, and ambient views.
* `app/chrome.js`: menus, context menus, search, and editor layout.
* `app/workbench.js`: settings, dialogs, panels, and typing mode.
* `app/profiles.js`: profile registration and defaults.
* `app/corpus`: individual project profiles.
* `app/generators.js`: generated source content for the fictional projects.
* `app/catalogue.js`: additional generated profiles.
* `fauxcode-app`: Python desktop launcher and Windows build files.
* `fauxcode-tauri`: optional Tauri packaging project.
* `tools`: preview server and checks.
* `docs/CORPUS_CONTRACT.md`: requirements for adding a profile.

## Checks

Node.js is needed for the profile validator. Run it against the individual corpus files:

```powershell
node tools/validate_corpus.js app/corpus/mobile.js app/corpus/gamedev.js app/corpus/enterprise.js app/corpus/devops.js app/corpus/dataeng.js
```

For the desktop smoke test, install the Python dependencies and run:

```powershell
.\.venv\Scripts\python.exe tools/smoke_desktop.py
```

The test starts its own temporary local server, exercises the workbench in WebView2, and writes `tools/smoke-results.json`. The server closes when the check finishes. After building the executable, `python tools/verify_exe.py` checks its window behavior.

## Adding a profile

Read [the profile contract](docs/CORPUS_CONTRACT.md). Create `app/corpus/<id>.js`, validate it, and add its script tag to `workbench.html` before `app/catalogue.js`. If it replaces a generated profile, remove the matching entry from the catalogue.

## Tauri packaging

The optional Tauri project has [separate setup instructions](fauxcode-tauri/README.md). Its frontend must be prepared from the current app before each build. The Tauri installer has not been verified for this publication.

Relief is an independent project. It is not affiliated with Microsoft or Visual Studio Code.
