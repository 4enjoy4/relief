"""Copy the current workbench into the Tauri frontend folder."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
frontend = Path(__file__).resolve().parent / 'src'
frontend.mkdir(exist_ok=True)
shutil.copy2(root / 'workbench.html', frontend / 'index.html')
shutil.copytree(root / 'app', frontend / 'app', dirs_exist_ok=True)
print('Tauri frontend prepared from the current project files.')
